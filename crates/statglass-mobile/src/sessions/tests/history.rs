use statglass_ipc::error::CommandError;
use statglass_ipc::history::{HistoryRequest, TierRequest};
use statglass_proto::{SyncPage, WireBucket};
use statglass_schema::{Event, EventDetail, SeriesSelector, SyncKinds, Tier};
use statglass_session::MirrorSink;

use super::*;

#[tokio::test(start_paused = true)]
async fn history_auto_uses_phone_coverage_and_events_read_the_same_mirror() {
    const DAY: i64 = 86_400_000;
    let host = host(1);
    let fixture = Fixture::start(vec![host.clone()], SyncPolicy::Off);
    let entry = fixture.sessions.registry.entry(host.id).unwrap();
    for (tier, from_ms, value) in [(Tier::M1, NOW - DAY, 21.), (Tier::M15, NOW - 7 * DAY, 35.)] {
        entry
            .mirror
            .cursor(tier, host.id.0, SyncKinds::ALL)
            .unwrap();
        entry
            .mirror
            .ingest(
                SyncPage {
                    tier,
                    epoch: host.id.0,
                    layouts: vec![WireLayout {
                        layout_no: 0,
                        series: vec![cpu()],
                    }],
                    rows: vec![WireBucket {
                        seq: 1,
                        bucket_ts: from_ms,
                        layout_no: 0,
                        stats: vec![value, value, value],
                    }],
                    gaps: vec![],
                    events: vec![],
                    last_seq: 1,
                    more: false,
                },
                SyncKinds::ALL,
            )
            .unwrap();
        let request = HistoryRequest {
            host: host.id,
            from_ms,
            to_ms: NOW,
            tier: TierRequest::Auto,
            max_points: 2_000,
            selectors: vec![SeriesSelector {
                metric: cpu().metric,
                labels: Default::default(),
            }],
        };
        let page = fixture
            .sessions
            .call(MobileCall::QueryHistory(request.clone()))
            .await
            .unwrap();
        assert_eq!(page["tier"], json!(tier));
        assert_eq!(page["series"][0]["key"], json!(cpu()));
        let point = json!({"t": from_ms, "min": value, "max": value, "avg": value});
        let points = if tier == Tier::M1 {
            json!([point])
        } else {
            // The HistoryStore also folds the covered minute into its quarter hour.
            json!([point, {"t": NOW - DAY, "min": 21., "max": 21., "avg": 21.}])
        };
        assert_eq!(page["series"][0]["points"], points);
        assert!(matches!(
            fixture
                .sessions
                .call(MobileCall::QueryHistory(HistoryRequest {
                    max_points: 0,
                    ..request
                }))
                .await,
            Err(CommandError::InvalidArgument { .. })
        ));
    }
    let remote = fixture
        .sessions
        .call(MobileCall::ListRemoteHosts)
        .await
        .unwrap();
    assert_eq!(remote[0]["synced_through_ms"], json!(NOW - DAY + 60_000));

    let event = Event {
        ts_ms: NOW,
        start_ms: NOW,
        processes: vec![],
        detail: EventDetail::FansRamped {
            from_rpm: 800.,
            to_rpm: 1_200.,
        },
    };
    let writer = entry.mirror.store().writer().unwrap();
    writer.record_event(host.id, &event).unwrap();
    writer.flush().unwrap();
    assert_eq!(
        fixture
            .sessions
            .call(MobileCall::QueryEvents {
                host: host.id,
                from_ms: NOW,
                to_ms: NOW + 1,
            })
            .await
            .unwrap(),
        json!([event])
    );
}

#[tokio::test(start_paused = true)]
async fn queued_reads_for_a_replaced_mirror_return_unknown_host() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()], SyncPolicy::Off);
    let mut dial = fixture.next_dial().await;
    dial.handshake(&host).await;
    let old = fixture.sessions.registry.entry(host.id).unwrap();
    let mut updated = host.clone();
    updated.name = "New name".into();
    fixture
        .sessions
        .set_hosts(vec![updated], SyncPolicy::Off)
        .unwrap();
    timeout(WAIT, &mut dial.closing).await.unwrap().unwrap();
    dial.finish_close.send(()).unwrap();
    let _new = fixture.next_dial().await;
    let request = HistoryRequest {
        host: host.id,
        from_ms: NOW - 60_000,
        to_ms: NOW,
        tier: TierRequest::M1,
        max_points: 1,
        selectors: vec![SeriesSelector {
            metric: cpu().metric,
            labels: Default::default(),
        }],
    };
    let unknown = Err(CommandError::UnknownHost { host: host.id });
    assert_eq!(old.query_history(&request), unknown);
    assert_eq!(old.query_events(host.id, NOW - 60_000, NOW), unknown);
}
