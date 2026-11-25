use statglass_engine::Source;
use statglass_ipc::live::LiveMsg;
use statglass_ipc::vitals::HostVitals;
use statglass_proto::SourceStatus;
use statglass_schema::Tier;

use crate::control::SessionControl;
use statglass_ipc::error::CommandError;

use super::*;

#[tokio::test(start_paused = true)]
async fn live_cpu_arrives_in_order_and_prioritizes_the_open_source() {
    let first = host(1);
    let second = host(2);
    let mut fixture = Fixture::start(vec![first.clone(), second.clone()], SyncPolicy::Off);
    let one = fixture.next_dial().await;
    let two = fixture.next_dial().await;
    let mut remote = if one.target == second.targets[0].host {
        one
    } else {
        two
    };
    remote.handshake(&second).await;
    assert_eq!(
        fixture
            .sessions
            .call(MobileCall::GetCapabilities { host: second.id })
            .await
            .unwrap()["revision"],
        5
    );
    let info = fixture
        .sessions
        .call(subscribe(second.id, 7))
        .await
        .unwrap();
    assert_eq!(
        info,
        json!({
            "host": second.id, "stream": 7, "backfill_start_ms": null,
            "backfill_rows": 0, "earlier_start_ms": null, "earlier_rows": 0,
        })
    );
    assert_eq!(
        fixture
            .sessions
            .sources()
            .iter()
            .map(|s| s.host().id)
            .collect::<Vec<_>>(),
        [second.id, first.id]
    );
    remote.layout().await;
    remote.frame(NOW, 11.).await;
    remote.frame(NOW + 1_000, 23.).await;
    let (stream, layout) = fixture.message("layout").await;
    assert_eq!(stream, 7);
    let series: Vec<SeriesKey> = serde_json::from_value(layout["series"].clone()).unwrap();
    assert_eq!(series, [cpu()]);

    for (time, cpu) in [(NOW, 11.), (NOW + 1_000, 23.)] {
        let (stream, message) = fixture.message("frame").await;
        assert_eq!(stream, 7);
        let expected = LiveMsg::Frame {
            ts_ms: time,
            layout_no: u32::try_from(layout["layout_no"].as_u64().unwrap()).unwrap(),
            timeline: u32::try_from(message["timeline"].as_u64().unwrap()).unwrap(),
            values: vec![Some(cpu)],
            held: vec![Some(cpu)],
        };
        assert_eq!(message, serde_json::to_value(expected).unwrap());
    }
    assert_eq!(
        fixture
            .sessions
            .call(MobileCall::HostVitals { host: second.id })
            .await
            .unwrap(),
        json!(HostVitals {
            cpu_pct: Some(23.),
            ..Default::default()
        })
    );
    assert_eq!(
        fixture
            .sessions
            .call(MobileCall::UnsubscribeLive { stream: 7 })
            .await
            .unwrap(),
        Value::Null
    );
    assert_eq!(fixture.sessions.sources()[0].host().id, first.id);
}

#[tokio::test(start_paused = true)]
async fn a_refused_frame_releases_the_stream_and_an_unknown_unsubscribe_is_a_noop() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()], SyncPolicy::Off);
    let mut remote = fixture.next_dial().await;
    remote.handshake(&host).await;
    assert_eq!(
        fixture
            .sessions
            .call(MobileCall::UnsubscribeLive { stream: 42 })
            .await
            .unwrap(),
        Value::Null
    );
    fixture.sessions.call(subscribe(host.id, 42)).await.unwrap();
    while !matches!(remote.read().await, Message::Interest(interest) if interest.detail) {}
    *fixture.events.refuse.lock_ok() = Some("frame");
    remote.layout().await;
    remote.frame(NOW, 11.).await;
    remote.frame(NOW + 1_000, 23.).await;
    assert_eq!(fixture.message("frame").await.0, 42);
    assert_eq!(fixture.sessions.registry.live.open_host(), None);
    while !matches!(remote.read().await, Message::Interest(interest) if !interest.detail) {}
    assert!(fixture.messages.try_recv().is_err());

    *fixture.events.refuse.lock_ok() = None;
    fixture.sessions.call(subscribe(host.id, 42)).await.unwrap();
    remote.frame(NOW + 2_000, 37.).await;
    let (stream, message) = fixture.message("frame").await;
    assert_eq!((stream, &message["held"]), (42, &json!([37.])));
}

#[tokio::test(start_paused = true)]
async fn a_listener_gone_during_initial_delivery_can_reuse_its_stream_id() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()], SyncPolicy::Off);
    *fixture.events.refuse.lock_ok() = Some("caps");
    assert!(fixture.sessions.call(subscribe(host.id, 8)).await.is_err());
    assert_eq!(fixture.message("caps").await.0, 8);
    assert!(fixture.messages.try_recv().is_err());
    assert_eq!(fixture.sessions.registry.live.open_host(), None);
    *fixture.events.refuse.lock_ok() = None;
    assert_eq!(
        fixture.sessions.call(subscribe(host.id, 8)).await.unwrap()["stream"],
        8
    );
}

#[tokio::test(start_paused = true)]
async fn a_host_added_before_any_policy_change_starts_full_sync() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![], SyncPolicy::Full);
    fixture.sessions.set_hosts(vec![host.clone()]).unwrap();
    let mut remote = fixture.next_dial().await;
    offer_history(&mut remote, &host).await;
    let Message::SyncRequest(request) = remote.read().await else {
        panic!("expected minute sync under the default policy");
    };
    assert_eq!(request.tier, Tier::M1);
}

#[tokio::test(start_paused = true)]
async fn a_later_source_uses_the_last_sync_policy_and_active_sources_follow_changes() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![], SyncPolicy::Full);
    fixture.sessions.set_sync_policy(SyncPolicy::Off);
    fixture.sessions.set_hosts(vec![host.clone()]).unwrap();
    let mut remote = fixture.next_dial().await;
    offer_history(&mut remote, &host).await;
    assert!(
        timeout(Duration::from_millis(500), codec::read(&mut remote.peer))
            .await
            .is_err(),
        "policy Off suppresses initial sync"
    );

    fixture.sessions.set_sync_policy(SyncPolicy::Full);
    assert!(matches!(remote.read().await, Message::Interest(_)));
    let Message::SyncRequest(request) = remote.read().await else {
        panic!("expected minute sync after enabling it")
    };
    assert_eq!(request.tier, Tier::M1);
}

async fn offer_history(remote: &mut Dial, host: &MobileHost) {
    remote.handshake(host).await;
    let Message::Ping { nonce, t0_ms } = remote.read().await else {
        panic!("expected clock probe")
    };
    codec::write(
        &mut remote.peer,
        &Message::Pong {
            nonce,
            t0_ms,
            t_remote_ms: NOW,
        },
    )
    .await
    .unwrap();
    codec::write(
        &mut remote.peer,
        &Message::SourceStatus(SourceStatus {
            history_available: true,
            interval_ms: 1_000,
            ..Default::default()
        }),
    )
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_in_flight_callback_keeps_its_stream_id_until_it_returns() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()], SyncPolicy::Off);
    let mut remote = fixture.next_dial().await;
    remote.handshake(&host).await;
    fixture.sessions.call(subscribe(host.id, 7)).await.unwrap();
    let (gate, entered, release) = CallbackGate::new();
    *fixture.events.live_gate.lock_ok() = Some(gate);
    remote.layout().await;
    remote.frame(NOW, 11.).await;
    timeout(WAIT, entered).await.unwrap().unwrap();
    fixture
        .sessions
        .call(MobileCall::UnsubscribeLive { stream: 7 })
        .await
        .unwrap();
    let reused = fixture.sessions.call(subscribe(host.id, 7)).await;
    release.send(()).unwrap();
    assert!(
        matches!(reused, Err(CommandError::InvalidArgument { .. })),
        "{reused:?}"
    );
    assert_eq!(fixture.message("frame").await.0, 7);
}

#[tokio::test(start_paused = true)]
async fn a_panicking_live_callback_unregisters_the_stream() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()], SyncPolicy::Off);
    let mut remote = fixture.next_dial().await;
    remote.handshake(&host).await;
    fixture.sessions.call(subscribe(host.id, 7)).await.unwrap();
    while !matches!(remote.read().await, Message::Interest(interest) if interest.detail) {}
    *fixture.events.panic_live.lock_ok() = true;
    remote.layout().await;
    remote.frame(NOW, 11.).await;
    while !matches!(remote.read().await, Message::Interest(interest) if !interest.detail) {}
    assert_eq!(
        fixture.sessions.call(subscribe(host.id, 7)).await.unwrap()["stream"],
        7
    );
}

#[tokio::test(start_paused = true)]
async fn a_panicking_status_callback_leaves_the_session_running() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()], SyncPolicy::Off);
    let mut remote = fixture.next_dial().await;
    *fixture.events.panic_event.lock_ok() = true;
    remote.handshake(&host).await;
    fixture.sessions.call(subscribe(host.id, 7)).await.unwrap();
    remote.layout().await;
    remote.frame(NOW, 11.).await;
    assert_eq!(fixture.message("frame").await.0, 7);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blocked_status_callback_does_not_block_live_frames() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()], SyncPolicy::Off);
    let mut remote = fixture.next_dial().await;
    remote.handshake(&host).await;
    fixture.sessions.call(subscribe(host.id, 7)).await.unwrap();
    let (gate, entered, release) = CallbackGate::new();
    *fixture.events.status_gate.lock_ok() = Some(gate);
    codec::write(
        &mut remote.peer,
        &Message::SourceStatus(SourceStatus::default()),
    )
    .await
    .unwrap();
    remote.layout().await;
    remote.frame(NOW, 11.).await;
    timeout(WAIT, entered).await.unwrap().unwrap();
    remote.frame(NOW + 1_000, 23.).await;
    let observed = timeout(WAIT, async {
        loop {
            let (_, frame) = fixture.message("frame").await;
            if frame["ts_ms"] == NOW + 1_000 {
                break;
            }
        }
    })
    .await;
    release.send(()).unwrap();
    observed.expect("a later frame arrives while the status callback is blocked");
}

#[tokio::test(start_paused = true)]
async fn frame_vitals_change_without_another_remote_hosts_event() {
    let host = host(1);
    let mut fixture = Fixture::start(vec![host.clone()], SyncPolicy::Off);
    let mut remote = fixture.next_dial().await;
    let read_events = |events: &Recorder| {
        events
            .events
            .lock_ok()
            .iter()
            .filter(|e| **e == remote_changed())
            .count()
    };
    timeout(WAIT, async {
        while read_events(&fixture.events) < 2 {
            fixture.events.event_ready.notified().await;
        }
    })
    .await
    .unwrap();
    fixture.events.events.lock_ok().clear();
    remote.handshake(&host).await;
    timeout(WAIT, async {
        while read_events(&fixture.events) == 0 {
            fixture.events.event_ready.notified().await;
        }
    })
    .await
    .unwrap();
    fixture.sessions.call(subscribe(host.id, 7)).await.unwrap();
    remote.layout().await;
    for (ts, cpu) in [(NOW, 11.), (NOW + 1_000, 23.)] {
        remote.frame(ts, cpu).await;
        assert_eq!(fixture.message("frame").await.1["ts_ms"], ts);
        let rows = fixture
            .sessions
            .call(MobileCall::ListRemoteHosts)
            .await
            .unwrap();
        assert_eq!(rows[0]["vitals"]["cpu_pct"], cpu);
        assert!(rows[0]["last_seen_ms"].is_i64());
    }
    assert!(
        timeout(Duration::from_secs(1), async {
            while read_events(&fixture.events) < 2 {
                fixture.events.event_ready.notified().await;
            }
        })
        .await
        .is_err(),
        "frames should not invalidate the remote host list"
    );
    assert_eq!(read_events(&fixture.events), 1);
}

#[tokio::test(start_paused = true)]
async fn an_open_stream_keeps_its_id_when_a_configured_host_is_rebuilt() {
    let other = host(2);
    let mut viewed = host(1);
    let mut fixture = Fixture::start(vec![other.clone(), viewed.clone()], SyncPolicy::Off);
    let first = fixture.next_dial().await;
    let second = fixture.next_dial().await;
    let (mut old, _other) = if first.target == viewed.targets[0].host {
        (first, second)
    } else {
        (second, first)
    };
    old.handshake(&viewed).await;
    fixture
        .sessions
        .call(subscribe(viewed.id, 7))
        .await
        .unwrap();
    old.layout().await;
    old.frame(NOW, 11.).await;
    assert_eq!(fixture.message("frame").await.0, 7);

    viewed.name = "Renamed".into();
    fixture
        .sessions
        .set_hosts(vec![other, viewed.clone()])
        .unwrap();
    timeout(WAIT, &mut old.closing).await.unwrap().unwrap();
    old.finish_close.send(()).unwrap();
    let mut new = fixture.next_dial().await;
    let initial = new.handshake(&viewed).await;
    assert_eq!(fixture.sessions.sources()[0].host().id, viewed.id);
    if !initial.detail {
        while !matches!(new.read().await, Message::Interest(interest) if interest.detail) {}
    }
    new.layout().await;
    new.frame(NOW + 1_000, 23.).await;
    let (id, frame) = fixture.message("frame").await;
    assert_eq!(id, 7);
    assert_eq!(frame["held"], json!([23.]));
}
