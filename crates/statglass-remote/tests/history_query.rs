use std::sync::Arc;
use std::time::{Duration, Instant};

use statglass_engine::{HistoryStore, LiveHub};
use statglass_proto::{
    Answer, ErrorCode, HistoryAnswer, HistoryClamp, HistoryQuery, Message, Offer, Query,
    RemoteInterest, encode_frame, local_features, negotiate,
};
use statglass_remote::history_query::{HISTORY_MAX_ANSWER_BYTES, HISTORY_MAX_EVENTS};
use statglass_remote::{
    DeviceTag, HostServer, ServedHost, ServerProvider, SessionScope, encode_preface,
    serve_connection,
};
use statglass_schema::{
    AlertCause, Capabilities, Event, EventDetail, GapReason, HostRecord, Module, PowerComponent,
    SeriesKey, SeriesSelector, ThermalState, Tier,
};
use statglass_session::codec;
use statglass_store::{
    HistoryQuery as StoreQuery, Retention, TierChoice, TierCoverage, range_stats,
    tier_budget::tier_for_budget,
};
use tokio::io::AsyncWriteExt;

#[path = "support/history_seed.rs"]
mod history_seed;
use history_seed::{host_record, seed_by_retention, seed_by_retention_with_layout};

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
const NOW: i64 = 1_791_158_400_000;

struct Host(HostRecord, LiveHub);

impl ServedHost for Host {
    fn record(&self) -> HostRecord {
        self.0.clone()
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }
    fn hub(&self) -> &LiveHub {
        &self.1
    }
    fn set_remote_interest(&self, _: u64, _: RemoteInterest) {}
}

fn server(store: Arc<HistoryStore>) -> HostServer<Host> {
    HostServer::new(Arc::new(Host(host_record(), LiveHub::default())), store)
}

fn key(text: &str) -> SeriesKey {
    SeriesKey::parse(text).expect("valid fixture series key")
}

fn series_for_chart() -> Vec<SeriesKey> {
    (0..20)
        .flat_map(|i| {
            [
                key(&format!("net.rx{{iface=eth{i}}}")),
                key(&format!("net.tx{{iface=eth{i}}}")),
            ]
        })
        .collect()
}

fn cores(count: usize) -> Vec<SeriesKey> {
    (0..count)
        .map(|i| key(&format!("cpu.load{{core={i:03}}}")))
        .collect()
}

fn request(from_ms: i64, to_ms: i64, series: &[SeriesKey], max_points: u32) -> HistoryQuery {
    HistoryQuery {
        from_ms,
        to_ms: Some(to_ms),
        series: series
            .iter()
            .map(|k| SeriesSelector {
                metric: k.metric.clone(),
                labels: k.labels.clone(),
            })
            .collect(),
        max_points,
        events_for: None,
    }
}

fn ask(server: &HostServer<Host>, request: HistoryQuery) -> HistoryAnswer {
    let answer = server.answer(1, Query::History(request));
    let Answer::History(answer) = answer else {
        panic!("expected history, got {answer:?}")
    };
    answer
}

fn thread_cpu() -> Duration {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: ts is writable and CLOCK_THREAD_CPUTIME_ID needs no other arguments.
    assert_eq!(
        unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) },
        0
    );
    Duration::new(
        ts.tv_sec.try_into().expect("nonnegative CPU seconds"),
        ts.tv_nsec.try_into().expect("CPU nanoseconds fit in u32"),
    )
}

fn wire_len(answer: &HistoryAnswer) -> usize {
    encode_frame(&Message::Reply {
        id: u32::MAX,
        answer: Answer::History(answer.clone()),
    })
    .expect("the fixture reply encodes")
    .len()
}

// Run the seeding process separately so its allocation peak is absent from query RSS.
#[test]
#[ignore = "release measurement against a separately seeded database"]
fn history_release_profile() {
    use std::path::PathBuf;

    let dir = PathBuf::from(std::env::var_os("STATGLASS_HISTORY_BENCH_DIR").unwrap());
    let chart = series_for_chart();
    let run = std::env::var("STATGLASS_HISTORY_BENCH_RUN").unwrap();
    if run == "seed-narrow" || run == "seed-wide" {
        let wide = run == "seed-wide";
        let mut seeded: Vec<_> = chart.iter().cloned().chain(cores(64)).collect();
        if wide {
            seeded.extend((0..96).map(|i| key(&format!("disk.used{{vol=volume-{i}}}"))));
            assert_eq!(seeded.len(), 200);
        }
        drop(seed_by_retention_with_layout(&dir, &seeded, NOW, wide));
        return;
    }
    let range = match run.as_str() {
        "1h" => HOUR,
        "24h" => DAY,
        "7d" => 7 * DAY,
        "30d" => 30 * DAY,
        _ => panic!("unknown measurement range {run}"),
    };
    let server = server(Arc::new(HistoryStore::open(&dir)));
    let query = request(NOW - range, NOW, &chart[..20], 200);
    let start = Instant::now();
    let cpu = thread_cpu();
    let answer = ask(&server, query);
    let cpu = thread_cpu() - cpu;
    let wall = start.elapsed();
    let bytes = wire_len(&answer);
    assert_eq!(answer.series.len(), 20);
    assert!(bytes < 160_000);
    eprintln!(
        "{run} wall_ms={:.3} cpu_ms={:.3} bytes={bytes}",
        wall.as_secs_f64() * 1_000.0,
        cpu.as_secs_f64() * 1_000.0
    );
}

#[tokio::test]
async fn history_reply_reaches_a_restricted_session() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(HistoryStore::open(dir.path()));
        store.register_host(&host_record()).unwrap();
        let (mut client, socket) = tokio::io::duplex(4096);
        let task = tokio::spawn(serve_connection(socket, Arc::new(server(store))));
        let Message::Hello(hello) = codec::read(&mut client).await.unwrap() else {
            panic!("expected a host hello")
        };
        let scope = SessionScope::Restricted {
            device: DeviceTag::parse("7F3A2C").unwrap(),
        };
        client.write_all(&encode_preface(&scope)).await.unwrap();
        let ack = negotiate(&Offer::local(local_features()), &Offer::from(&*hello))
            .unwrap()
            .ack();
        codec::write(&mut client, &Message::HelloAck(ack))
            .await
            .unwrap();
        assert!(matches!(
            codec::read(&mut client).await.unwrap(),
            Message::SourceStatus(_)
        ));
        let query = Query::History(request(NOW - HOUR, NOW, &[key("cpu.total")], 200));
        codec::write(
            &mut client,
            &Message::Request {
                id: 1,
                query: query.clone(),
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            codec::read(&mut client).await.unwrap(),
            Message::Reply {
                id: 1,
                answer: Answer::History(_)
            }
        ));

        let mut frame = encode_frame(&Message::Request { id: 2, query }).unwrap();
        let tag = frame
            .windows(7)
            .position(|bytes| bytes == b"History")
            .unwrap();
        frame[tag..tag + 7].copy_from_slice(b"FutureQ");
        client.write_all(&frame).await.unwrap();
        assert!(matches!(
            codec::read(&mut client).await.unwrap(),
            Message::Reply {
                id: 2,
                answer: Answer::Error {
                    code: ErrorCode::Unsupported,
                    ..
                }
            }
        ));
        drop(client);
        assert!(task.await.unwrap().is_err());
    })
    .await
    .expect("the restricted session must answer history");
}

#[test]
fn history_wire_bounds_and_query_costs() {
    let dir = tempfile::tempdir().unwrap();
    let chart = series_for_chart();
    let seeded: Vec<_> = chart.iter().cloned().chain(cores(64)).collect();
    let server = server(seed_by_retention(dir.path(), &seeded, NOW));
    for (label, range, tier) in [
        ("1 h", HOUR, Tier::S10),
        ("24 h", DAY, Tier::M1),
        ("7 d", 7 * DAY, Tier::M15),
        ("30 d", 30 * DAY, Tier::M15),
    ] {
        let q = request(NOW - range, NOW, &chart[..20], 200);
        let start = Instant::now();
        let cpu = thread_cpu();
        let answer = ask(&server, q);
        let cpu = thread_cpu() - cpu;
        let wall = start.elapsed();
        let bytes = wire_len(&answer);
        eprintln!("{label}: wall {wall:?}, thread CPU {cpu:?}, {bytes} bytes");
        assert_eq!(answer.tier, tier);
        assert!(answer.clamped.is_empty());
        assert_eq!(answer.series.len(), 20);
        assert!(
            answer
                .series
                .iter()
                .all(|s| (100..=200).contains(&s.points.len()))
        );
        assert!(answer.series.iter().map(|s| s.points.len()).sum::<usize>() <= 4_000);
        assert!(bytes < 160_000, "{label}: {bytes} bytes");
    }
    let answer = ask(&server, request(NOW - 10_000_000, NOW, &chart[..1], 5_000));
    assert_eq!(answer.series[0].points.len(), 500);
    assert_eq!(answer.clamped, [HistoryClamp::Points]);
    let answer = ask(&server, request(NOW - DAY, NOW, &chart, 200));
    assert_eq!(answer.series.len(), 32);
    assert_eq!(answer.clamped, [HistoryClamp::Series]);
}

#[test]
fn history_heatmap_clamps_requested_and_matched_keys_and_reduces_oversized_replies() {
    let dir = tempfile::tempdir().unwrap();
    let cores = cores(300);
    let total = key("cpu.total");
    let seeded: Vec<_> = cores.iter().cloned().chain([total.clone()]).collect();
    let store = seed_by_retention(dir.path(), &seeded, NOW);
    let server = server(store.clone());

    let query = |series: &[SeriesKey], max_points| request(NOW - HOUR, NOW, series, max_points);
    let answer = ask(&server, query(&cores[..64], 60));
    assert_eq!(answer.series.len(), 64);
    assert!(answer.clamped.is_empty());
    assert!(answer.series.iter().all(|s| s.points.len() == 60));

    for series in [&cores[..], &[key("cpu.load")][..]] {
        let answer = ask(&server, query(series, 60));
        assert_eq!(answer.series.len(), 256);
        assert_eq!(answer.clamped, [HistoryClamp::Series]);
    }

    let mixed: Vec<_> = [total].into_iter().chain(cores.iter().cloned()).collect();
    let answer = ask(&server, query(&mixed, 60));
    assert_eq!(answer.series.len(), 32);
    assert_eq!(answer.clamped, [HistoryClamp::Series]);

    let from = NOW - 2 * HOUR + 10_500;
    // A gap within a source bucket changes the time weights used for range stats.
    let writer = store.writer().unwrap();
    writer
        .write_gap(
            host_record().id,
            statglass_schema::Gap::module_disabled(from + 1, Some(from + 5_001), Module::Cpu),
        )
        .unwrap();
    writer.flush().unwrap();
    let answer = ask(&server, request(from, NOW, &cores[..256], 500));
    assert_eq!(answer.series.len(), 256);
    let bytes = wire_len(&answer);
    assert!(bytes <= HISTORY_MAX_ANSWER_BYTES, "{bytes} bytes");
    assert!(answer.clamped.contains(&HistoryClamp::Bytes));
    assert!(
        answer
            .series
            .iter()
            .all(|s| (1..=250).contains(&s.points.len()))
    );
    let key = &answer.series[0].key;
    let base = answer.tier.bucket_start(from).unwrap();
    let max_points = u32::try_from((NOW - base + answer.bucket_ms - 1) / answer.bucket_ms).unwrap();
    let selectors = request(from, NOW, std::slice::from_ref(key), max_points).series;
    let expected = store
        .read(|reader| {
            reader.history(&StoreQuery {
                host: host_record().id,
                selectors,
                from_ms: from,
                to_ms: NOW,
                max_points,
                tier: TierChoice::Fixed(answer.tier),
            })
        })
        .unwrap();
    assert_eq!(answer.bucket_ms, expected.bucket_ms);
    let expected_points: Vec<_> = expected.series[0]
        .points
        .iter()
        .map(|p| (p.t, p.avg, p.min, p.max))
        .collect();
    assert_eq!(answer.series[0].points, expected_points);
    let full = store
        .read(|reader| {
            reader.history(&StoreQuery {
                host: host_record().id,
                from_ms: from,
                to_ms: NOW,
                max_points: 500,
                tier: TierChoice::Fixed(answer.tier),
                selectors: request(from, NOW, std::slice::from_ref(key), 500).series,
            })
        })
        .unwrap();
    let def = statglass_schema::Catalog::builtin()
        .get("cpu.load")
        .unwrap();
    let full_stats = range_stats(&full, &[def], from, NOW, NOW);
    assert_ne!(full.bucket_ms, answer.bucket_ms);
    assert_eq!(answer.stats[0].key, *key);
    assert_eq!(
        answer.stats[0].avg,
        full_stats.metrics[0].avg.map(|n| n as f32)
    );
    assert_eq!(
        answer.stats[0].peak,
        full_stats.metrics[0].max.map(|n| n as f32)
    );
}

#[test]
fn history_leaves_a_hole_for_a_midrange_gap() {
    let dir = tempfile::tempdir().unwrap();
    let cpu = [key("cpu.total")];
    let store = seed_by_retention(dir.path(), &cpu, NOW);
    let writer = store.writer().unwrap();
    let server = server(store);
    let q = request(NOW - HOUR, NOW, &cpu, 500);
    let before = ask(&server, q.clone());
    let start = NOW - HOUR / 2;
    let end = start + 10 * 10_000;
    let gap = statglass_schema::Gap::module_disabled(start, Some(end), Module::Cpu);
    writer.write_gap(host_record().id, gap).unwrap();
    writer.flush().unwrap();

    let after = ask(&server, q);
    let points = &after.series[0].points;
    assert_eq!(after.gaps, [gap]);
    assert_eq!(before.series[0].points.len() - points.len(), 10);
    assert!(points.iter().all(|p| !(start..end).contains(&p.0)));
    assert!(points.iter().any(|p| p.0 == end));
}

#[test]
fn history_keeps_post_gap_measurements_in_a_slot_starting_inside_the_gap() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(HistoryStore::open(dir.path()));
    let host = host_record();
    let writer = store.register_host(&host).unwrap();
    let cpu = key("cpu.total");
    let layout: Arc<[SeriesKey]> = Arc::from([cpu.clone()]);
    let from = NOW - 60_000;
    let gap = statglass_schema::Gap::module_disabled(from, Some(from + 20_000), Module::Cpu);
    writer.write_gap(host.id, gap).unwrap();
    for (offset, stats) in [
        (0, [80.0, 100.0, 90.0]),
        (10_000, [70.0, 90.0, 80.0]),
        (20_000, [15.0, 19.0, 17.0]),
    ] {
        writer
            .write_bucket(statglass_store::BucketRow {
                host: host.id,
                tier: Tier::S10,
                bucket_ts: from + offset,
                series: layout.clone(),
                stats: stats.to_vec(),
            })
            .unwrap();
    }
    writer.flush().unwrap();
    let reply = ask(&server(store), request(from, NOW, &[cpu], 2));
    assert_eq!(reply.bucket_ms, 30_000);
    assert_eq!(reply.gaps, [gap]);
    assert_eq!(reply.series[0].points, [(from, 17.0, 15.0, 19.0)]);
}

#[test]
fn history_invalid_ranges_and_selectors_and_known_empty_range() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(HistoryStore::open(dir.path()));
    let host = host_record();
    let writer = store.register_host(&host).unwrap();
    writer
        .open_gap(host.id, NOW - HOUR, None, GapReason::Sleep)
        .unwrap();
    writer.flush().unwrap();
    let server = server(store);
    let cpu = [key("cpu.total")];
    for q in [
        request(NOW, NOW - 1, &cpu, 50),
        request(NOW, NOW, &cpu, 50),
        request(i64::MIN, NOW, &cpu, 50),
        request(NOW - 100, NOW, &[], 50),
        request(NOW - 100, NOW, &[key("unknown.metric")], 50),
    ] {
        assert!(matches!(
            server.answer(1, Query::History(q)),
            Answer::Error {
                code: ErrorCode::InvalidArgument,
                ..
            }
        ));
    }
    let answer = ask(&server, request(NOW - HOUR / 2, NOW, &cpu, 50));
    assert!(answer.series.is_empty());
    assert_eq!(answer.gaps.len(), 1);
    assert_eq!(answer.gaps[0].start_ms, NOW - HOUR);
    assert_eq!(answer.gaps[0].end_ms, None);
}

#[test]
fn history_unknown_metric_error_stays_bounded() {
    let server = server(Arc::new(HistoryStore::unavailable()));
    let prefix = "a".repeat(64);
    let metric = key(&format!("{prefix}{}", "b".repeat(HISTORY_MAX_ANSWER_BYTES)));
    let answer = server.answer(1, Query::History(request(NOW - HOUR, NOW, &[metric], 200)));
    assert_eq!(
        answer,
        Answer::Error {
            code: ErrorCode::InvalidArgument,
            message: format!("Unknown history metric {prefix}"),
        }
    );
    let bytes = encode_frame(&Message::Reply { id: 1, answer })
        .unwrap()
        .len();
    assert!(bytes <= HISTORY_MAX_ANSWER_BYTES, "{bytes} bytes");
}

#[test]
fn history_timestamp_error_names_the_bound_value_and_limit() {
    let server = server(Arc::new(HistoryStore::unavailable()));
    let cpu = [key("cpu.total")];
    for (bound, value, q) in [
        ("from_ms", i64::MIN, request(i64::MIN, NOW, &cpu, 200)),
        ("to_ms", i64::MAX, request(NOW - HOUR, i64::MAX, &cpu, 200)),
    ] {
        let Answer::Error {
            code: ErrorCode::InvalidArgument,
            message,
        } = server.answer(1, Query::History(q))
        else {
            panic!("expected invalid {bound}")
        };
        assert!(message.contains(bound), "{message}");
        assert!(message.contains(&value.to_string()), "{message}");
        assert!(message.contains("±2^53"), "{message}");
    }
}

#[test]
fn history_distinguishes_unavailable_store_and_corrupt_bucket() {
    let q = request(NOW - HOUR, NOW, &[key("cpu.total")], 200);
    let unavailable = server(Arc::new(HistoryStore::unavailable()));
    assert!(matches!(
        unavailable.answer(1, Query::History(q.clone())),
        Answer::Error {
            code: ErrorCode::HistoryUnavailable,
            ..
        }
    ));

    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(HistoryStore::open(dir.path()));
    let host = host_record();
    let writer = store.register_host(&host).unwrap();
    writer
        .write_bucket(statglass_store::BucketRow {
            host: host.id,
            tier: Tier::S10,
            bucket_ts: NOW - 10_000,
            series: Arc::from([key("cpu.total")]),
            stats: vec![10.0, 30.0, 20.0],
        })
        .unwrap();
    writer.flush().unwrap();
    let conn = statglass_store::rusqlite::Connection::open(
        dir.path().join(statglass_engine::HISTORY_DB_FILE),
    )
    .unwrap();
    assert_eq!(
        conn.execute("UPDATE tier_10s SET blob = x''", []).unwrap(),
        1
    );
    assert!(matches!(
        server(store).answer(1, Query::History(q)),
        Answer::Error {
            code: ErrorCode::Internal,
            ..
        }
    ));
}

#[test]
fn history_tier_budget_and_pruned_start() {
    let retained = TierCoverage {
        s10_ms: Some(DAY),
        m1_ms: Some(7 * DAY),
    };
    for (span, tier) in [
        (HOUR, Tier::S10),
        (DAY, Tier::M1),
        (7 * DAY, Tier::M15),
        (30 * DAY, Tier::M15),
        (1, Tier::S10),
    ] {
        assert_eq!(tier_for_budget(NOW - span, NOW, 200, retained), tier);
    }
    let dir = tempfile::tempdir().unwrap();
    let series = [key("cpu.total")];
    let store = seed_by_retention(dir.path(), &series, NOW);
    let server = server(store);
    let cutoff = NOW - Retention::DAY_MS;
    assert_eq!(
        ask(&server, request(cutoff, cutoff + HOUR, &series, 200)).tier,
        Tier::S10
    );
    assert_eq!(
        ask(
            &server,
            request(cutoff - 1, cutoff + HOUR - 1, &series, 200)
        )
        .tier,
        Tier::M1
    );
    let cutoff = NOW - Retention::M1_WINDOW_MS;
    assert_eq!(
        ask(&server, request(cutoff - HOUR, cutoff, &series, 200)).tier,
        Tier::M15
    );
}

#[test]
fn history_stats_match_individual_keys() {
    let dir = tempfile::tempdir().unwrap();
    let keys = [key("net.rx{iface=eth0}"), key("net.rx{iface=eth1}")];
    let store = seed_by_retention(dir.path(), &keys, NOW);
    let host = host_record();
    let start = NOW - HOUR;
    let server = server(store.clone());
    let network = ask(&server, request(start, NOW, &[key("net.rx")], 200));
    assert_eq!(network.stats.len(), 2);
    for (found, key) in network.stats.iter().zip(&keys) {
        let single = StoreQuery {
            host: host.id,
            from_ms: start,
            to_ms: NOW,
            tier: TierChoice::Fixed(network.tier),
            max_points: 200,
            selectors: request(start, NOW, std::slice::from_ref(key), 200).series,
        };
        let read = store.read(|reader| reader.history(&single)).unwrap();
        let def = statglass_schema::Catalog::builtin().get("net.rx").unwrap();
        let expected = &range_stats(&read, &[def], start, NOW, NOW).metrics[0];
        assert_eq!(&found.key, key);
        assert_eq!(found.avg, expected.avg.map(|n| n as f32));
        assert_eq!(found.peak, expected.max.map(|n| n as f32));
    }
    assert_ne!(network.stats[0].avg, network.stats[1].avg);
}

#[test]
fn history_events_match_the_module() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(HistoryStore::open(dir.path()));
    let host = host_record();
    let writer = store.register_host(&host).unwrap();
    let start = NOW - HOUR;
    for (i, detail) in [
        EventDetail::PowerSpike {
            component: PowerComponent::Ane,
            watts: 1.2,
            baseline_watts: 0.3,
        },
        EventDetail::FansRamped {
            from_rpm: 1_000.0,
            to_rpm: 3_000.0,
        },
        EventDetail::ThermalState {
            from: None,
            to: ThermalState::Serious,
        },
        EventDetail::SustainedProcess {
            process: "rustc".into(),
            cpu_pct: 70.0,
            secs: 60,
        },
        EventDetail::Alert {
            rule_id: uuid::Uuid::nil(),
            rule_name: "RAM".into(),
            cause: AlertCause::Threshold {
                metric: key("mem.used").metric,
                labels: Default::default(),
                value: 45.0,
                op: statglass_schema::Cmp::Gt,
                threshold: 42.0,
                for_secs: 5,
            },
        },
    ]
    .into_iter()
    .enumerate()
    {
        let ts_ms = start + i64::try_from(i).unwrap() * 1000;
        writer
            .record_event(
                host.id,
                &Event {
                    ts_ms,
                    start_ms: ts_ms,
                    processes: vec![],
                    detail,
                },
            )
            .unwrap();
    }
    writer.flush().unwrap();
    let server = server(store);
    let mut q = request(start, NOW, &[key("net.rx")], 200);
    for (module, kinds) in [
        (
            Module::Power,
            &["power_spike", "fans_ramped", "thermal_state"][..],
        ),
        (Module::Cpu, &["sustained_process"]),
        (Module::Memory, &["alert"]),
        (Module::Network, &[]),
    ] {
        q.events_for = Some(module);
        let answer = ask(&server, q.clone());
        assert_eq!(
            answer
                .events
                .iter()
                .map(|e| e.kind.as_str())
                .collect::<Vec<_>>(),
            kinds
        );
        assert!(
            answer
                .events
                .iter()
                .all(|e| e.seq > 0 && !e.payload.is_empty())
        );
    }
}

#[test]
fn history_event_clamp_keeps_latest_matching_rows_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(HistoryStore::open(dir.path()));
    let host = host_record();
    let writer = store.register_host(&host).unwrap();
    for offset in 0..=i64::try_from(HISTORY_MAX_EVENTS).unwrap() {
        let ts_ms = NOW - HOUR + offset;
        writer
            .record_event(
                host.id,
                &Event {
                    ts_ms,
                    start_ms: ts_ms,
                    processes: vec![],
                    detail: EventDetail::FansRamped {
                        from_rpm: 1_000.0,
                        to_rpm: 3_000.0,
                    },
                },
            )
            .unwrap();
    }
    writer
        .record_event(
            host.id,
            &Event {
                ts_ms: NOW - 1,
                start_ms: NOW - 1,
                processes: vec![],
                detail: EventDetail::SustainedProcess {
                    process: "build".into(),
                    cpu_pct: 91.0,
                    secs: 30,
                },
            },
        )
        .unwrap();
    writer.flush().unwrap();
    let mut q = request(NOW - HOUR, NOW, &[key("cpu.total")], 200);
    q.events_for = Some(Module::Power);
    let answer = ask(&server(store), q);
    assert_eq!(answer.clamped, [HistoryClamp::Events]);
    assert_eq!(answer.events.len(), HISTORY_MAX_EVENTS);
    assert_eq!(answer.events.first().unwrap().ts_ms, NOW - HOUR + 1);
    assert!(
        answer
            .events
            .windows(2)
            .all(|pair| pair[0].ts_ms < pair[1].ts_ms)
    );
}

#[test]
fn history_filters_fixed_event_kinds_without_decoding_their_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(HistoryStore::open(dir.path()));
    let host = host_record();
    store.register_host(&host).unwrap();
    let conn = statglass_store::rusqlite::Connection::open(
        dir.path().join(statglass_engine::HISTORY_DB_FILE),
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO events (host_id, ts, kind, payload, seq)
        VALUES (1, 1000, 'power_spike', x'ff', 1),
               (1, 1001, 'sustained_process', 42, 2);",
    )
    .unwrap();
    let mut q = request(0, 10_000, &[key("cpu.total")], 50);
    q.events_for = Some(Module::Power);
    let answer = ask(&server(store), q);
    assert_eq!(answer.events.len(), 1);
    assert_eq!(answer.events[0].kind, "power_spike");
    assert_eq!(answer.events[0].payload, [0xff]);
}

#[test]
fn history_breaks_equal_event_times_and_kinds_by_row_id() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(HistoryStore::open(dir.path()));
    let host = host_record();
    store.register_host(&host).unwrap();
    let conn = statglass_store::rusqlite::Connection::open(
        dir.path().join(statglass_engine::HISTORY_DB_FILE),
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO events (id, host_id, ts, kind, payload, seq)
        VALUES (30, 1, 1000, 'power_spike', x'ff', 3),
               (10, 1, 1000, 'power_spike', x'ff', 2),
               (20, 1, 1000, 'power_spike', x'ff', 1);",
    )
    .unwrap();
    let mut q = request(0, 10_000, &[key("cpu.total")], 50);
    q.events_for = Some(Module::Power);
    let answer = ask(&server(store), q);
    assert_eq!(
        answer.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
        [2, 1, 3]
    );
}
