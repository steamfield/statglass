use statglass_engine::{BusMsg, HistoryStore, LiveHub, ProcessBatch, disk_space::SpaceService};
use statglass_proto::{
    Answer, ErrorCode, Hello, LiveTier, Message, Offer, Query, RemoteInterest, SyncRequest,
};
use statglass_remote::{
    DeviceSeenLog, DeviceTag, HostServer, ServedHost, ServerProvider, SessionScope, encode_preface,
    serve_connection,
};
use statglass_schema::{
    Capabilities, Event, EventDetail, HostId, HostInfo, HostRecord, OsKind, SyncKinds, Tier,
    disk_space::{SpacePhase, SpaceTarget},
    durable_usage::{HistoricalUsageMetric, HistoricalUsageRequest, UsageProcessRequest},
    lock::LockExt,
    usage::UsageKey,
};
use statglass_session::codec;
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncWriteExt, DuplexStream};
use uuid::Uuid;

fn restricted() -> SessionScope {
    SessionScope::Restricted {
        device: DeviceTag::parse("7F3A2C").expect("valid fixture tag"),
    }
}

fn queries() -> [Query; 13] {
    let host = HostId(Uuid::nil());
    [
        Query::UsageByApp {
            from_ms: 0,
            to_ms: 1,
            by: UsageKey::Cpu,
            limit: 1,
        },
        Query::HistoricalUsage(HistoricalUsageRequest {
            host,
            from_ms: 0,
            to_ms: 1,
            by: HistoricalUsageMetric::Cpu,
            app_names: vec![],
        }),
        Query::UsageProcesses(UsageProcessRequest {
            host,
            from_ms: 0,
            to_ms: 1,
            app_name: "Example".into(),
            by: HistoricalUsageMetric::Cpu,
            page_size: 1,
            cursor: None,
        }),
        Query::SpaceVolumes,
        Query::SpaceStatus,
        Query::SpaceStart {
            volume: "/".into(),
            include: vec![],
        },
        Query::SpaceCancel,
        Query::SpaceClear,
        Query::SpaceReport,
        Query::SpaceLargestFiles { report: 1 },
        Query::SpacePath {
            report: 1,
            target: SpaceTarget::Node { id: 0 },
        },
        Query::SpaceSubtree {
            report: 1,
            node: None,
        },
        Query::Unknown,
    ]
}

struct Host {
    record: HostRecord,
    hub: LiveHub,
    interest: Mutex<RemoteInterest>,
}

impl ServedHost for Host {
    fn record(&self) -> HostRecord {
        self.record.clone()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn hub(&self) -> &LiveHub {
        &self.hub
    }

    fn set_remote_interest(&self, _session: u64, interest: RemoteInterest) {
        *self.interest.lock_ok() = interest;
    }
}

struct Fixture {
    host: Arc<Host>,
    server: HostServer<Host>,
    queries: Mutex<Vec<Query>>,
}

impl ServerProvider for Fixture {
    fn hello(&self) -> Hello {
        self.server.hello()
    }
    fn live(&self) -> LiveHub {
        self.server.live()
    }
    fn set_interest(&self, session: u64, interest: RemoteInterest) {
        self.server.set_interest(session, interest);
    }
    fn sync(&self, request: &SyncRequest, kinds: SyncKinds) -> Result<Message, String> {
        self.server.sync(request, kinds)
    }
    fn recent(&self, from: i64, to: i64) -> Result<Message, String> {
        self.server.recent(from, to)
    }
    fn answer(&self, session: u64, query: Query) -> Answer {
        self.queries.lock_ok().push(query.clone());
        self.server.answer(session, query)
    }
    fn end_session(&self, session: u64) {
        self.server.end_session(session);
    }
    fn device_seen(&self) -> Option<&DeviceSeenLog> {
        self.server.device_seen()
    }
}

fn fixture(path: &Path, seen: DeviceSeenLog) -> (Arc<Fixture>, Arc<SpaceService>) {
    let host = Arc::new(Host {
        record: HostRecord {
            id: HostId(Uuid::nil()),
            is_local: true,
            display_name: "Fixture Linux".into(),
            info: HostInfo {
                os: OsKind::Linux,
                os_version: "Fixture".into(),
                model: None,
                chip: None,
                chip_known: false,
                cpu_topology: vec![],
                mem_total_bytes: 0,
                boot_time_ms: 0,
                gpu_dvfs_mhz: vec![],
                boot_mounts: vec![],
                kernel: None,
            },
        },
        hub: LiveHub::default(),
        interest: Mutex::default(),
    });
    let history = Arc::new(HistoryStore::open(path));
    let writer = history
        .register_host(&host.record)
        .expect("register fixture host");
    writer
        .record_event(
            host.record.id,
            &Event {
                ts_ms: 3000,
                start_ms: 2000,
                processes: vec![],
                detail: EventDetail::FansRamped {
                    from_rpm: 2000.0,
                    to_rpm: 3200.0,
                },
            },
        )
        .expect("write an event to sync");
    writer.flush().expect("flush fixture history");
    let space = Arc::new(SpaceService::folder(path.to_path_buf()));
    let server = HostServer::new(host.clone(), history)
        .with_space(space.clone())
        .with_device_seen(seen);
    (
        Arc::new(Fixture {
            host,
            server,
            queries: Mutex::default(),
        }),
        space,
    )
}

fn connection(
    fixture: Arc<Fixture>,
) -> (
    DuplexStream,
    tokio::task::JoinHandle<statglass_remote::Result<()>>,
) {
    let (client, server) = tokio::io::duplex(65536);
    (client, tokio::spawn(serve_connection(server, fixture)))
}

async fn read(client: &mut DuplexStream) -> Message {
    tokio::time::timeout(Duration::from_secs(5), codec::read(client))
        .await
        .expect("server must make protocol progress")
        .expect("read a server message")
}

async fn handshake(client: &mut DuplexStream, scope: SessionScope) {
    let Message::Hello(hello) = read(client).await else {
        panic!("expected Hello");
    };
    client
        .write_all(&encode_preface(&scope))
        .await
        .expect("write the local preface");
    let ack = statglass_proto::negotiate(
        &Offer::local(statglass_proto::local_features()),
        &Offer::from(&*hello),
    )
    .expect("negotiate with the fixture host")
    .ack();
    codec::write(client, &Message::HelloAck(ack))
        .await
        .expect("acknowledge Hello");
    assert!(matches!(read(client).await, Message::SourceStatus(_)));
}

#[tokio::test]
async fn either_scope_can_subscribe_read_processes_ping_sync_and_read_recent_rows() {
    let dir = tempfile::tempdir().unwrap();
    let seen_path = dir.path().join("seen");
    let (fixture, _) = fixture(dir.path(), DeviceSeenLog::new(seen_path.clone()));
    for scope in [SessionScope::Full, restricted()] {
        let (mut client, server) = connection(fixture.clone());
        handshake(&mut client, scope).await;
        let interest = RemoteInterest {
            detail: true,
            process_period_ms: Some(1000),
            network_processes: true,
            ..Default::default()
        };
        codec::write(&mut client, &Message::Interest(interest.clone()))
            .await
            .unwrap();
        assert!(matches!(read(&mut client).await, Message::SourceStatus(_)));
        assert_eq!(*fixture.host.interest.lock_ok(), interest);
        fixture
            .host
            .hub
            .publish(BusMsg::Processes(Arc::new(ProcessBatch {
                ts_ms: 1234,
                gpu_span_ms: None,
                rows: Vec::new(),
            })));
        assert!(
            matches!(read(&mut client).await, Message::LiveProcesses(batch) if batch.ts_ms == 1234 && batch.rows.is_empty())
        );
        codec::write(&mut client, &Message::Unsubscribe)
            .await
            .unwrap();
        codec::write(
            &mut client,
            &Message::Subscribe {
                tiers: vec![LiveTier::Live1s],
            },
        )
        .await
        .unwrap();
        codec::write(
            &mut client,
            &Message::Ping {
                nonce: 19,
                t0_ms: 101,
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            read(&mut client).await,
            Message::Pong {
                nonce: 19,
                t0_ms: 101,
                ..
            }
        ));
        assert_eq!(
            *fixture.host.interest.lock_ok(),
            RemoteInterest {
                detail: true,
                ..Default::default()
            }
        );

        assert_sync_and_recent(&mut client).await;
        drop(client);
        assert!(server.await.unwrap().is_err());
        let seen = DeviceSeenLog::new(seen_path.clone()).read();
        match scope {
            SessionScope::Full => assert!(seen.is_empty()),
            SessionScope::Restricted { device } => {
                assert_eq!(seen.keys().copied().collect::<Vec<_>>(), [device])
            }
        }
    }
}

async fn assert_sync_and_recent(client: &mut DuplexStream) {
    codec::write(
        client,
        &Message::SyncRequest(SyncRequest {
            tier: Tier::M1,
            after: None,
            max_rows: 5,
            from_ms: None,
            max_bytes: None,
        }),
    )
    .await
    .expect("request durable history");
    let Message::SyncPage(page) = read(client).await else {
        panic!("expected SyncPage");
    };
    assert_eq!(page.tier, Tier::M1);
    assert_eq!(page.events.len(), 1);
    assert_eq!(
        (page.events[0].ts_ms, page.events[0].kind.as_str()),
        (3000, "fans_ramped")
    );

    codec::write(
        client,
        &Message::RecentRequest {
            from_ms: 1,
            to_ms: 2,
        },
    )
    .await
    .expect("request recent history");
    assert!(
        matches!(read(client).await, Message::RecentRows { tier: Tier::S10, rows, .. } if rows.is_empty())
    );
}

#[tokio::test]
async fn every_query_is_refused_before_it_reaches_the_provider() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, space) = fixture(dir.path(), DeviceSeenLog::new(dir.path().join("seen")));
    let (mut client, server) = connection(fixture.clone());
    handshake(&mut client, restricted()).await;
    for (id, query) in (0..).zip(queries()) {
        assert!(SessionScope::Full.allows(&query), "{query:?}");
        assert!(!restricted().allows(&query), "{query:?}");
        let query = if matches!(query, Query::SpaceStart { .. }) {
            Query::SpaceStart {
                volume: space.volumes().remove(0).mount,
                include: vec![],
            }
        } else {
            query
        };
        codec::write(&mut client, &Message::Request { id, query })
            .await
            .unwrap();
    }
    for id in 0..queries().len() as u32 {
        assert!(matches!(
            read(&mut client).await,
            Message::Reply { id: received, answer: Answer::Error { code: ErrorCode::Unsupported, .. } }
                if received == id
        ));
    }
    drop(client);
    assert!(server.await.unwrap().is_err());
    assert!(fixture.queries.lock_ok().is_empty());
    assert_eq!(space.status().phase, SpacePhase::Idle);
}

#[tokio::test]
async fn bad_prefaces_close_before_hello_ack() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _) = fixture(dir.path(), DeviceSeenLog::new(dir.path().join("seen")));
    for body in [
        Some(b"{oops}".as_slice()),
        Some(br#"{"scope":"restricted","device":"7f3a2c"}"#.as_slice()),
        Some(br#"{"scope":"full","device":"7F3A2C"}"#.as_slice()),
        None,
    ] {
        let (mut client, server) = connection(fixture.clone());
        assert!(matches!(read(&mut client).await, Message::Hello(_)));
        client.write_all(b"SGSP").await.unwrap();
        let size = body.map_or(1025, |body| body.len() as u16);
        client.write_u16(size).await.unwrap();
        client.write_all(body.unwrap_or(&[])).await.unwrap();
        let error = tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(
            matches!(error, statglass_remote::RemoteError::Protocol(message) if message.starts_with("bad session preface"))
        );
    }
    assert!(fixture.device_seen().unwrap().read().is_empty());
}

#[tokio::test]
async fn preface_is_local_and_legacy_readers_fail_closed() {
    let body = br#"{"scope":"restricted","device":"7F3A2C"}"#;
    let mut expected = b"SGSP".to_vec();
    expected.extend_from_slice(&(body.len() as u16).to_be_bytes());
    expected.extend_from_slice(body);
    assert_eq!(encode_preface(&restricted()), expected);
    assert_eq!(
        statglass_remote::read_preface(&mut expected.as_slice())
            .await
            .unwrap(),
        (restricted(), None)
    );
    assert!(
        matches!(codec::read(&mut expected.as_slice()).await, Err(statglass_remote::RemoteError::Protocol(message)) if message.starts_with("frame length"))
    );
}

#[tokio::test]
async fn device_seen_write_failure_leaves_the_session_usable() {
    let dir = tempfile::tempdir().unwrap();
    let (fixture, _) = fixture(dir.path(), DeviceSeenLog::new(dir.path().to_path_buf()));
    let (mut client, server) = connection(fixture);
    handshake(&mut client, restricted()).await;
    codec::write(&mut client, &Message::Ping { nonce: 7, t0_ms: 0 })
        .await
        .unwrap();
    assert!(matches!(
        read(&mut client).await,
        Message::Pong { nonce: 7, .. }
    ));
    drop(client);
    assert!(server.await.unwrap().is_err());
}

#[test]
fn seen_log_keeps_the_latest_timestamp_through_reopens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("seen");
    let tag = DeviceTag::parse("7F3A2C").unwrap();
    DeviceSeenLog::new(path.clone()).record(tag, 1234);
    DeviceSeenLog::new(path.clone()).record(tag, 1000);
    assert_eq!(DeviceSeenLog::new(path).read().get(&tag), Some(&1234));
}

#[test]
fn seen_log_compacts_past_64_kib_and_preserves_latest_times() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("seen");
    let held = std::fs::File::create(&path).unwrap();
    held.lock().unwrap();
    let log = DeviceSeenLog::new(path.clone());
    let phone = DeviceTag::parse("7F3A2C").unwrap();
    let tablet = DeviceTag::parse("0BADC0").unwrap();
    for time in 0..1600 {
        log.record(phone, time);
        log.record(tablet, 1600 - time);
    }
    let size_before = std::fs::metadata(&path).unwrap().len();
    assert!(size_before > 64 * 1024, "compaction must skip a locked log");
    let before = log.read();
    assert_eq!(before, [(phone, 1599), (tablet, 1600)].into());
    drop(held);

    log.record(phone, 5);
    assert!(std::fs::metadata(&path).unwrap().len() < 64 * 1024);
    let compacted = std::fs::read_to_string(&path).unwrap();
    assert_eq!(compacted.lines().filter(|line| !line.is_empty()).count(), 2);
    assert_eq!(DeviceSeenLog::new(path).read(), before);
}

#[tokio::test]
async fn a_held_advisory_log_lock_cannot_stall_a_restricted_session() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("seen");
    let lock = std::fs::File::create(&path).unwrap();
    lock.lock().unwrap();
    let (fixture, _) = fixture(dir.path(), DeviceSeenLog::new(path.clone()));
    let (mut client, server) = connection(fixture);
    let completed =
        tokio::time::timeout(Duration::from_secs(2), handshake(&mut client, restricted())).await;
    drop(lock);
    drop(client);
    assert!(server.await.unwrap().is_err());
    assert!(
        completed.is_ok(),
        "last-seen recording held up SourceStatus"
    );
    assert_eq!(DeviceSeenLog::new(path).read().len(), 1);
}
