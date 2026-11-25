use std::{collections::HashMap, sync::Arc, time::Duration};

use serde_json::Value;
use statglass_engine::Source;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{DemandLevel, HostDemand};
use statglass_session::{BoxFuture, RemoteSource};

use crate::lifecycle::{DemandSource, Lifecycle};

use super::{Sessions, host::HostEntry};

/// How long a host stays connected after no screen demands it. Long enough that swiping
/// across the pager and back, or a quick look at Settings, keeps the SSH session (a fresh
/// dial and handshake costs 1-3 s on LAN, more on Tailscale); short enough that nothing
/// keeps pulling once the user has moved on.
pub(crate) const PARK_GRACE: Duration = Duration::from_secs(15);

pub(crate) fn set_demand(
    sessions: &Sessions,
    demand: Vec<HostDemand>,
) -> Result<Value, CommandError> {
    let mut hosts = HashMap::new();
    for HostDemand { host, level } in demand {
        if hosts.get(&host) != Some(&DemandLevel::Full) {
            hosts.insert(host, level);
        }
    }
    sessions.lifecycle().replace_demand(hosts, PARK_GRACE);
    Ok(Value::Null)
}

pub(crate) fn admit(source: &RemoteSource, _lifecycle: &Lifecycle) {
    // Start parked even for a demanded host: its first wire interest is set
    // through the handle created by start, before the runner may dial.
    drop(source.quiesce());
}

impl Lifecycle {
    pub(super) fn install(&self, entry: &Arc<HostEntry>) -> Result<(), CommandError> {
        admit(&entry.source, self);
        self.track(entry.source.host().id, entry.clone(), || entry.start())
    }
}

impl DemandSource for HostEntry {
    fn level(&self, level: Option<DemandLevel>) {
        self.set_demand_level(level);
    }

    fn resume(&self) {
        self.resume_demand();
    }

    fn park(&self, close_streams: bool) -> BoxFuture<'static, ()> {
        self.park_demand(close_streams)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use statglass_engine::ProcessView;
    use statglass_ipc::mobile::{DataPolicy, MobileCall};
    use statglass_proto::{HostSummary, Message, RemoteInterest, SourceStatus};
    use statglass_schema::SeriesKey;
    use statglass_session::codec;
    use tokio::time::timeout;

    use super::*;
    use crate::ffi::NetworkPath;
    use crate::sessions::tests::{Dial, Fixture, WAIT, host, subscribe};

    async fn demand(sessions: &Sessions, levels: &[(statglass_schema::HostId, DemandLevel)]) {
        let demand = levels
            .iter()
            .map(|&(host, level)| HostDemand { host, level })
            .collect();
        assert_eq!(
            sessions
                .call(MobileCall::SetDemand { demand })
                .await
                .unwrap(),
            Value::Null
        );
    }

    async fn interest(peer: &mut Dial, expected: RemoteInterest) {
        timeout(WAIT, async {
            loop {
                match peer.read().await {
                    Message::Interest(actual) if actual == expected => return,
                    Message::Interest(_) => {}
                    Message::Ping { nonce, t0_ms } => answer_ping(peer, nonce, t0_ms).await,
                    other => panic!("unexpected demand message {other:?}"),
                }
            }
        })
        .await
        .unwrap();
    }

    async fn answer_ping(peer: &mut Dial, nonce: u64, t0_ms: i64) {
        codec::write(
            &mut peer.peer,
            &Message::Pong {
                nonce,
                t0_ms,
                t_remote_ms: statglass_engine::wall_ms(),
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn demand_parks_at_grace_and_releases_the_stream_and_ring() {
        let host = host(1);
        let mut fixture = Fixture::start(vec![host.clone()]);
        let sessions = fixture.sessions.clone();
        let mut peer = fixture.next_dial().await;
        assert!(peer.handshake(&host).await.detail);
        sessions.call(subscribe(host.id, 7)).await.unwrap();
        peer.layout().await;
        peer.frame(1_000, 23.0).await;
        assert_eq!(fixture.message("frame").await.1["held"], json!([23.]));

        demand(&sessions, &[]).await;
        let one_ms = Duration::from_millis(1);
        assert!(
            timeout(PARK_GRACE - one_ms, &mut peer.closing)
                .await
                .is_err()
        );
        timeout(one_ms * 2, &mut peer.closing)
            .await
            .unwrap()
            .unwrap();
        peer.finish_close.send(()).unwrap();
        let entry = sessions.registry.entry(host.id).unwrap().running().unwrap();
        entry.source.quiesce().await;
        assert_eq!(sessions.registry.live.open_host(), None);
        assert!(entry.hub.backfill(i64::MIN).is_empty());
        assert!(entry.hub.latest_frame().is_none());
        assert!(fixture.dials.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn demand_background_during_grace_releases_the_dropped_hosts_stream() {
        let host = host(1);
        let mut fixture = Fixture::start(vec![host.clone()]);
        let sessions = fixture.sessions.clone();
        let mut peer = fixture.next_dial().await;
        peer.handshake(&host).await;
        sessions.call(subscribe(host.id, 7)).await.unwrap();
        demand(&sessions, &[]).await;
        let lifecycle = sessions.lifecycle();
        let parked = lifecycle.quiesce(&sessions);
        timeout(Duration::from_secs(1), &mut peer.closing)
            .await
            .unwrap()
            .unwrap();
        peer.finish_close.send(()).unwrap();
        parked.await;
        assert_eq!(sessions.registry.live.open_host(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn demand_returning_in_grace_keeps_the_same_session() {
        let host = host(1);
        let mut fixture = Fixture::start(vec![host.clone()]);
        let mut peer = fixture.next_dial().await;
        peer.handshake(&host).await;
        demand(&fixture.sessions, &[]).await;
        interest(&mut peer, RemoteInterest::default()).await;
        assert!(timeout(PARK_GRACE / 2, &mut peer.closing).await.is_err());
        demand(&fixture.sessions, &[(host.id, DemandLevel::Full)]).await;
        interest(
            &mut peer,
            RemoteInterest {
                detail: true,
                ..Default::default()
            },
        )
        .await;
        assert!(timeout(PARK_GRACE, &mut peer.closing).await.is_err());
        assert!(fixture.dials.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn demand_compact_reads_summaries_and_full_respects_cellular_policy() {
        let host = host(1);
        let mut fixture = Fixture::start_parked(vec![host.clone()], None);
        let sessions = fixture.sessions.clone();
        demand(&sessions, &[(host.id, DemandLevel::Compact)]).await;
        let mut peer = fixture.next_dial().await;
        assert_eq!(peer.handshake(&host).await, RemoteInterest::default());
        let Message::Ping { nonce, t0_ms } = peer.read().await else {
            panic!("expected a heartbeat");
        };
        answer_ping(&mut peer, nonce, t0_ms).await;
        sessions.call(subscribe(host.id, 7)).await.unwrap();
        for (ts_ms, value) in [(5_000, 11.0), (10_000, 23.0)] {
            codec::write(
                &mut peer.peer,
                &Message::HostSummary(HostSummary {
                    ts_ms,
                    online: true,
                    headline: vec![(SeriesKey::parse("cpu.total").unwrap(), value)],
                }),
            )
            .await
            .unwrap();
            let (_, frame) = fixture.message("frame").await;
            assert_eq!(
                (frame["ts_ms"].as_i64(), frame["held"][0].as_f64()),
                (Some(ts_ms), Some(f64::from(value)))
            );
            assert_eq!(frame["values"], json!([null]));
            assert_eq!(
                sessions
                    .call(MobileCall::HostVitals { host: host.id })
                    .await
                    .unwrap()["cpu_pct"],
                value
            );
        }
        assert!(
            timeout(Duration::from_secs(1), codec::read(&mut peer.peer))
                .await
                .is_err(),
            "local subscriptions must not enable wire detail or request recent rows"
        );

        let lifecycle = sessions.lifecycle();
        lifecycle.path_changed(
            &sessions,
            NetworkPath {
                satisfied: true,
                expensive: true,
                constrained: false,
            },
        );
        demand(&sessions, &[(host.id, DemandLevel::Full)]).await;
        let status = sessions.call(MobileCall::ListRemoteHosts).await.unwrap();
        assert_eq!(status[0]["demand"], "compact");
        let status = Message::SourceStatus(SourceStatus {
            interval_ms: 1_000,
            ..Default::default()
        });
        codec::write(&mut peer.peer, &status).await.unwrap();
        assert_eq!(fixture.message("status").await.1["frame_period_ms"], 5_000);
        lifecycle.set_data_policy(DataPolicy {
            live_on_cellular: true,
        });
        interest(
            &mut peer,
            RemoteInterest {
                detail: true,
                ..Default::default()
            },
        )
        .await;
        let status = sessions.call(MobileCall::ListRemoteHosts).await.unwrap();
        assert_eq!(status[0]["demand"], "full");
        codec::write(
            &mut peer.peer,
            &Message::SourceStatus(SourceStatus {
                interval_ms: 1_000,
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        assert_eq!(fixture.message("status").await.1["frame_period_ms"], 1_000);
    }

    #[tokio::test(start_paused = true)]
    async fn demand_summary_memory_percent_uses_the_capacity_from_hello() {
        let host = host(1);
        let mut fixture = Fixture::start_parked(vec![host.clone()], None);
        let sessions = fixture.sessions.clone();
        let saved = sessions.call(MobileCall::ListHosts).await.unwrap();
        let get_host = || MobileCall::GetHost { host: host.id };
        assert_eq!(sessions.call(get_host()).await.unwrap(), saved[0]);
        assert_eq!(saved[0]["info"]["mem_total_bytes"], 0);
        demand(&sessions, &[(host.id, DemandLevel::Compact)]).await;
        let mut peer = fixture.next_dial().await;
        let mut identity = super::super::endpoint::record(&host).identity();
        let capacity = 16_u64 * 1024 * 1024 * 1024;
        identity.info.mem_total_bytes = capacity;
        peer.handshake_as(identity, statglass_proto::local_features())
            .await;
        sessions.call(subscribe(host.id, 7)).await.unwrap();
        codec::write(
            &mut peer.peer,
            &Message::HostSummary(HostSummary {
                ts_ms: 5_000,
                online: true,
                headline: vec![(
                    SeriesKey::parse("mem.used").unwrap(),
                    8.0 * 1024.0 * 1024.0 * 1024.0,
                )],
            }),
        )
        .await
        .unwrap();
        fixture.message("frame").await;
        let reported = sessions.call(MobileCall::ListHosts).await.unwrap();
        assert_eq!(sessions.call(get_host()).await.unwrap(), reported[0]);
        assert_eq!(reported[0]["info"]["mem_total_bytes"], capacity);
        assert_eq!(reported[0]["display_name"], saved[0]["display_name"]);
        let vitals = sessions
            .call(MobileCall::HostVitals { host: host.id })
            .await
            .unwrap();
        assert_eq!(vitals["memory_pct"], 50.);
    }

    #[tokio::test(start_paused = true)]
    async fn demand_process_flags_end_with_their_live_stream() {
        let host = host(1);
        let mut fixture = Fixture::start(vec![host.clone()]);
        let mut peer = fixture.next_dial().await;
        peer.handshake(&host).await;
        let sessions = &fixture.sessions;
        sessions.call(subscribe(host.id, 7)).await.unwrap();
        sessions
            .call(MobileCall::SetProcessInterest {
                host: host.id,
                interested: true,
                view: Some(ProcessView {
                    period_ms: Some(1_000),
                    network: true,
                    gpu: true,
                    ..Default::default()
                }),
                stream: Some(7),
            })
            .await
            .unwrap();
        interest(
            &mut peer,
            RemoteInterest {
                detail: true,
                process_period_ms: Some(1_000),
                network_processes: true,
                gpu_processes: true,
                ..Default::default()
            },
        )
        .await;
        sessions
            .call(MobileCall::UnsubscribeLive { stream: 7 })
            .await
            .unwrap();
        interest(
            &mut peer,
            RemoteInterest {
                detail: true,
                ..Default::default()
            },
        )
        .await;
    }

    #[tokio::test(start_paused = true)]
    async fn demand_installed_in_background_dials_only_demanded_hosts_on_resume() {
        let first = host(1);
        let late = host(2);
        let unused = host(3);
        let mut fixture = Fixture::start_parked(vec![first.clone()], None);
        let sessions = fixture.sessions.clone();
        let lifecycle = sessions.lifecycle();
        assert!(
            timeout(Duration::from_millis(100), fixture.dials.recv())
                .await
                .is_err()
        );
        lifecycle.quiesce(&sessions).await;
        sessions
            .set_hosts(vec![first.clone(), late.clone(), unused.clone()])
            .unwrap();
        demand(
            &sessions,
            &[
                (first.id, DemandLevel::Compact),
                (late.id, DemandLevel::Full),
            ],
        )
        .await;
        assert!(
            timeout(Duration::from_millis(100), fixture.dials.recv())
                .await
                .is_err()
        );
        lifecycle.resume(&sessions);
        let mut dial = fixture.next_dial().await;
        assert_eq!(dial.target, late.targets[0].host);
        assert!(dial.handshake(&late).await.detail);
        let mut dial = fixture.next_dial().await;
        assert_eq!(dial.target, first.targets[0].host);
        assert!(!dial.handshake(&first).await.detail);
        assert!(
            timeout(Duration::from_millis(100), fixture.dials.recv())
                .await
                .is_err()
        );
        demand(&sessions, &[(unused.id, DemandLevel::Compact)]).await;
        assert_eq!(fixture.next_dial().await.target, unused.targets[0].host);
    }
}
