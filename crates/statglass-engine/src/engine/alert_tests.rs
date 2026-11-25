use super::*;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use statglass_collect::{Cadence, CollectError, CollectorId};
use statglass_schema::{
    AlertCause, AlertRule, Cmp, Condition, Entitlement, EventDetail, OsKind, SeriesSelector,
};

use crate::test_support::bare_host;
use crate::{
    BusMsg, FakeClock, FakeTicker, HistoryStore, LiveHub, LocalSource, NoPowerSignals, Source,
};

struct Cpu(SeriesKey, Arc<AtomicBool>);

impl Collector for Cpu {
    fn id(&self) -> CollectorId {
        CollectorId("cpu_alert_test")
    }

    fn cadence(&self) -> Cadence {
        Cadence::EveryTick
    }

    fn required_entitlements(&self) -> &'static [Entitlement] {
        &[Entitlement::None]
    }

    fn modules(&self) -> &'static [Module] {
        &[Module::Cpu]
    }

    fn probe(&mut self) -> Probe {
        Probe::Supported(vec![self.0.clone()])
    }

    fn sample(&mut self, _: &Tick, out: &mut SampleBuf) -> Result<(), CollectError> {
        let value = if self.1.load(std::sync::atomic::Ordering::Relaxed) {
            95.0
        } else {
            0.0
        };
        out.push(&self.0, value);
        Ok(())
    }
}

fn alert_fixture() -> (EngineParts, FakeClock, Arc<AtomicBool>, AlertRule) {
    let series = SeriesKey::parse("cpu.total").unwrap();
    let high = Arc::new(AtomicBool::new(true));
    let (ticker, clock) = FakeTicker::new();
    let parts = EngineParts {
        collectors: vec![Box::new(Cpu(series.clone(), Arc::clone(&high)))],
        ticker: Box::new(ticker),
        power: Box::new(NoPowerSignals),
        hints: None,
    };
    let rule = AlertRule {
        id: uuid::Uuid::from_u128(1),
        name: "High CPU".into(),
        when: Condition::Threshold {
            series: SeriesSelector {
                metric: series.metric,
                labels: series.labels,
            },
            op: Cmp::Gt,
            value: 80.0,
        },
        for_secs: 2,
        cooldown_secs: 60,
        enabled: true,
    };
    (parts, clock, high, rule)
}

#[tokio::test]
async fn local_source_applies_a_rule_without_restarting() {
    let (parts, clock, _, rule) = alert_fixture();
    let record = bare_host(1, "test agent", OsKind::Linux);
    let mut settings = Settings::agent_default();
    let source = Arc::new(LocalSource::new(record, parts, settings.clone()));
    let live = LiveHub::default();
    let mut subscriber = live.subscribe();
    let mut handle = Arc::clone(&source)
        .start(SourceSink { live, store: None })
        .unwrap();
    let control = source.engine().unwrap();
    // An acknowledged command proves the engine is ready to accept fake ticks.
    control
        .set_store(None)
        .recv_timeout(Duration::from_secs(5))
        .unwrap();

    let tick = async |subscriber: &mut crate::Subscriber| {
        assert!(clock.tick());
        let expected = clock.now().wall_ms;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match subscriber.recv().await.unwrap() {
                    BusMsg::Frame(frame) if frame.ts_ms == expected => {
                        assert!(frame.values.contains(&95.0));
                        break;
                    }
                    BusMsg::Event(event) => panic!("early event: {event:?}"),
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
    };
    tick(&mut subscriber).await;
    tick(&mut subscriber).await;

    settings.alerts.rules.push(rule.clone());
    handle.control().apply_settings(&settings);
    tick(&mut subscriber).await;
    tick(&mut subscriber).await;
    handle.stop();
    let events: Vec<_> = std::iter::from_fn(|| subscriber.try_recv())
        .filter_map(|msg| match msg {
            BusMsg::Event(event) => Some(event),
            _ => None,
        })
        .collect();
    let [event] = events.as_slice() else {
        panic!("expected one event: {events:?}")
    };
    assert_eq!(event.ts_ms, clock.now().wall_ms);
    assert!(matches!(event.detail, EventDetail::Alert { rule_id, .. } if rule_id == rule.id));
}

#[test]
fn running_engine_seed_from_sqlite_suppresses_refire_during_cooldown() {
    let (parts, clock, high, rule) = alert_fixture();
    let record = bare_host(1, "test agent", OsKind::Linux);
    let now = clock.now().wall_ms;
    let dir = tempfile::tempdir().unwrap();
    let history = HistoryStore::open(dir.path());
    let writer = history.register_host(&record).unwrap();
    let firing = Event {
        ts_ms: now - 10_000,
        start_ms: now - 12_000,
        processes: Vec::new(),
        detail: EventDetail::Alert {
            rule_id: rule.id,
            rule_name: rule.name.clone(),
            cause: AlertCause::Threshold {
                metric: statglass_schema::MetricId::from_static("cpu.total"),
                labels: Default::default(),
                value: 95.0,
                op: Cmp::Gt,
                threshold: 80.0,
                for_secs: 2,
            },
        },
    };
    writer.record_event(record.id, &firing).unwrap();
    writer.flush().unwrap();

    let mut settings = Settings::agent_default();
    settings.alerts.rules.push(rule.clone());
    let live = LiveHub::default();
    let mut subscriber = live.subscribe();
    let mut engine = Engine::new(
        record.id,
        parts,
        SourceSink { live, store: None },
        &settings,
    );
    engine.start();
    let seed = history.recent_alerts(record.id, now, &settings.alerts);
    assert_eq!(seed, std::slice::from_ref(&firing));
    engine.control().seed_alert_history(seed);
    let _attached = engine.control().set_store(Some(writer.clone()));
    let tick = |engine: &mut Engine| {
        assert!(clock.tick());
        assert!(engine.pump());
    };
    for _ in 0..3 {
        tick(&mut engine);
    }
    while let Some(msg) = subscriber.try_recv() {
        assert!(
            !matches!(msg, BusMsg::Event(_)),
            "seeded rule fired inside its cooldown"
        );
    }
    // Clear the old episode, then bring back the condition after cooldown expiry.
    high.store(false, std::sync::atomic::Ordering::Relaxed);
    tick(&mut engine);
    clock.advance(Duration::from_secs(60));
    high.store(true, std::sync::atomic::Ordering::Relaxed);
    for _ in 0..3 {
        tick(&mut engine);
    }
    writer.flush().unwrap();
    let events = history
        .alerts_since(record.id, firing.ts_ms, clock.now().wall_ms)
        .unwrap();
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[0], firing);
    assert!(events[1].ts_ms >= firing.ts_ms + 60_000);
    assert!(matches!(events[1].detail, EventDetail::Alert { rule_id, .. } if rule_id == rule.id));
    engine.control().shutdown();
    assert!(!engine.pump());
}
