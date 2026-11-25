use statglass_ipc::{error::CommandError, mobile::HostHistoryRequest};
use statglass_proto::{
    Answer, ErrorCode, HISTORY_QUERY_FEATURE, HistoryAnswer, HistoryClamp, HistoryQuery, Query,
    WireEvent, WireHistorySeries, WireSeriesStats,
};
use statglass_schema::{Event, EventDetail, Gap, GapReason, Module, SeriesSelector, Tier};
use tokio::time::Instant;

use super::*;

fn query(host: HostId) -> HostHistoryRequest {
    HostHistoryRequest {
        host,
        series: vec![SeriesSelector {
            metric: cpu().metric,
            labels: Default::default(),
        }],
        from_ms: NOW - 60_000,
        to_ms: Some(NOW),
        max_points: 31,
        events_for: Some(Module::Cpu),
    }
}

async fn handshake(peer: &mut Dial, host: &MobileHost, history: bool) {
    let mut features = statglass_proto::local_features();
    if !history {
        assert!(features.remove(HISTORY_QUERY_FEATURE));
    }
    peer.handshake_with_features(host, features).await;
    assert!(matches!(peer.read().await, Message::Ping { .. }));
}

async fn reply(peer: &mut Dial, request: &HostHistoryRequest, answer: Answer) {
    let message = peer.read().await;
    let Message::Request { id, query } = message else {
        panic!("expected one history request, got {message:?}");
    };
    assert_eq!(
        query,
        Query::History(HistoryQuery {
            series: request.series.clone(),
            from_ms: request.from_ms,
            to_ms: request.to_ms,
            max_points: request.max_points,
            events_for: request.events_for,
        })
    );
    codec::write(&mut peer.peer, &Message::Reply { id, answer })
        .await
        .unwrap();
}

fn wire_event(seq: i64, ts_ms: i64, kind: &str, payload: &impl serde::Serialize) -> WireEvent {
    let mut bytes = Vec::new();
    ciborium::into_writer(payload, &mut bytes).unwrap();
    WireEvent {
        source_id: None,
        seq,
        ts_ms,
        kind: kind.into(),
        payload: bytes,
    }
}

#[tokio::test(start_paused = true)]
async fn the_host_page_keeps_points_gaps_stats_and_known_events_without_retaining_rows() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()]);
    let mut peer = fixture.next_dial().await;
    handshake(&mut peer, &host, true).await;
    let request = query(host.id);
    let point = (NOW - 10_000, 20.0, 11.0, 35.0);
    let gap = Gap::new(NOW - 40_000, Some(NOW - 30_000), None, GapReason::Sleep).unwrap();
    let event = Event {
        ts_ms: NOW - 20_000,
        start_ms: NOW - 25_000,
        processes: vec!["example".into()],
        detail: EventDetail::SustainedProcess {
            process: "example".into(),
            cpu_pct: 25.0,
            secs: 5,
        },
    };
    let later = Event {
        ts_ms: NOW - 12_000,
        ..event.clone()
    };
    let answer = HistoryAnswer {
        tier: Tier::S10,
        bucket_ms: 10_000,
        complete_to_ms: NOW - 1_000,
        series: vec![WireHistorySeries {
            key: cpu(),
            points: vec![point],
            hold_ms: 12_000,
        }],
        gaps: vec![gap],
        events: vec![
            wire_event(1, event.ts_ms, event.detail.kind(), &event),
            wire_event(2, NOW - 18_000, "future_detector", &event),
            wire_event(3, later.ts_ms, later.detail.kind(), &later),
        ],
        stats: vec![WireSeriesStats {
            key: cpu(),
            avg: Some(22.0),
            peak: Some(35.0),
        }],
        clamped: vec![HistoryClamp::Bytes, HistoryClamp::Unknown],
    };
    let (page, ()) = tokio::join!(
        fixture
            .sessions
            .call(MobileCall::HostHistory(request.clone())),
        reply(&mut peer, &request, Answer::History(answer)),
    );
    assert_eq!(
        page.unwrap(),
        json!({
            "tier": "s10", "bucket_ms": 10_000, "complete_to_ms": NOW - 1_000,
            "series": [{
                "key": cpu(), "hold_ms": 12_000,
                "points": [{"t": point.0, "avg": point.1, "min": point.2, "max": point.3}],
            }],
            "gaps": [gap],
            "events": [event, later],
            "stats": [{"key": cpu(), "avg": 22.0, "peak": 35.0}],
            "clamped": [{"kind": "bytes"}, {"kind": "unknown"}],
        })
    );
    let registry = &fixture.sessions.registry;
    let entry = registry.entry(host.id).unwrap().running().unwrap();
    assert!(entry.hub.latest_frame().is_none());
    assert!(entry.hub.backfill(i64::MIN).is_empty());
    assert!(
        entry
            .hub
            .recent_rows(host.id, i64::MIN, i64::MAX)
            .is_empty()
    );

    let empty = HistoryAnswer {
        tier: Tier::S10,
        bucket_ms: 10_000,
        complete_to_ms: NOW,
        series: Vec::new(),
        gaps: Vec::new(),
        events: Vec::new(),
        stats: Vec::new(),
        clamped: Vec::new(),
    };
    let (second, ()) = tokio::join!(
        fixture
            .sessions
            .call(MobileCall::HostHistory(request.clone())),
        reply(&mut peer, &request, Answer::History(empty)),
    );
    assert_eq!(
        second.unwrap(),
        json!({
            "tier": "s10", "bucket_ms": 10_000, "complete_to_ms": NOW,
            "series": [], "gaps": [], "events": [], "stats": [], "clamped": [],
        })
    );
}

#[tokio::test(start_paused = true)]
async fn a_host_without_history_support_receives_no_request() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()]);
    let mut peer = fixture.next_dial().await;
    handshake(&mut peer, &host, false).await;
    assert!(matches!(
        fixture
            .sessions
            .call(MobileCall::HostHistory(query(host.id)))
            .await,
        Err(CommandError::RemoteUnsupported { .. }),
    ));
    assert!(timeout(WAIT, codec::read(&mut peer.peer)).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn a_busy_host_returns_its_typed_error_without_a_retry() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()]);
    let mut peer = fixture.next_dial().await;
    handshake(&mut peer, &host, true).await;
    let request = query(host.id);
    let message = "history queue is full".to_owned();
    let (page, ()) = tokio::join!(
        fixture
            .sessions
            .call(MobileCall::HostHistory(request.clone())),
        reply(
            &mut peer,
            &request,
            Answer::Error {
                code: ErrorCode::Busy,
                message: message.clone()
            }
        ),
    );
    assert_eq!(page, Err(CommandError::RemoteBusy { message }));
    assert!(timeout(WAIT, codec::read(&mut peer.peer)).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn history_fails_at_once_while_disconnected_and_is_never_sent_after_connecting() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()]);
    let mut peer = fixture.next_dial().await;
    let before = Instant::now();
    assert_eq!(
        timeout(
            Duration::ZERO,
            fixture
                .sessions
                .call(MobileCall::HostHistory(query(host.id)))
        )
        .await
        .unwrap(),
        Err(CommandError::RemoteUnreachable {
            message: "the host is not connected".into()
        }),
    );
    assert_eq!(Instant::now(), before);
    handshake(&mut peer, &host, true).await;
    assert!(timeout(WAIT, codec::read(&mut peer.peer)).await.is_err());
}
