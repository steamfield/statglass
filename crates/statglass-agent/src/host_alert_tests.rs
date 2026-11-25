use super::*;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use statglass_collect::{Cadence, CollectError, Collector, CollectorId, Probe, SampleBuf, Tick};
use statglass_engine::{
    BusMsg, ClockReading, FakeClock, FakeTicker, Inbox, NoPowerSignals, Subscriber, Ticker,
};
use statglass_proto::HostAlertRules;
use statglass_schema::{
    AlertCause, AlertRule, Cmp, Condition, Entitlement, EventDetail, HostId, HostInfo, Labels,
    MetricId, Module, OsKind, SeriesKey, SeriesSelector,
};

const HOST: HostId = HostId(Uuid::from_u128(7));
const CPU: MetricId = MetricId::from_static("cpu.total");
const WAIT: Duration = Duration::from_secs(5);

struct HighCpu(SeriesKey);

impl Collector for HighCpu {
    fn id(&self) -> CollectorId {
        CollectorId("agent_alert_test_cpu")
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
        out.push(&self.0, 95.0);
        Ok(())
    }
}

struct TestTicker {
    ticker: FakeTicker,
    clock: FakeClock,
    started: Option<mpsc::Sender<()>>,
    tick_on_read: Arc<AtomicBool>,
}

impl TestTicker {
    fn new() -> (Self, mpsc::Receiver<()>) {
        let (ticker, clock) = FakeTicker::at(statglass_engine::now());
        let (started, ready) = mpsc::channel();
        (
            Self {
                ticker,
                clock,
                started: Some(started),
                tick_on_read: Arc::default(),
            },
            ready,
        )
    }

    fn parts(self) -> EngineParts {
        EngineParts {
            collectors: vec![Box::new(HighCpu(SeriesKey::parse("cpu.total").unwrap()))],
            ticker: Box::new(self),
            power: Box::new(NoPowerSignals),
            hints: None,
        }
    }
}

impl Ticker for TestTicker {
    fn start(&mut self, inbox: Inbox, period: Duration, leeway: Duration) {
        self.ticker.start(inbox, period, leeway);
        if let Some(started) = self.started.take() {
            started.send(()).unwrap();
        }
    }

    fn stop(&mut self) {
        self.ticker.stop();
    }

    fn now(&self) -> ClockReading {
        let at = self.ticker.now();
        if self.tick_on_read.swap(false, Ordering::Relaxed) {
            assert!(self.clock.tick());
        }
        at
    }
}

fn record() -> HostRecord {
    HostRecord {
        id: HOST,
        is_local: true,
        display_name: "test agent".into(),
        info: HostInfo {
            os: OsKind::Linux,
            os_version: String::new(),
            model: None,
            chip: None,
            chip_known: false,
            cpu_topology: Vec::new(),
            mem_total_bytes: 0,
            boot_time_ms: 0,
            gpu_dvfs_mhz: Vec::new(),
            kernel: None,
            boot_mounts: Vec::new(),
        },
    }
}

fn rule(for_secs: u32) -> AlertRule {
    AlertRule {
        id: Uuid::from_u128(1),
        name: "High CPU".into(),
        when: Condition::Threshold {
            series: SeriesSelector {
                metric: CPU,
                labels: Labels::default(),
            },
            op: Cmp::Gt,
            value: 80.0,
        },
        for_secs,
        cooldown_secs: 60,
        enabled: true,
    }
}

fn firing(rule: &AlertRule, start_ms: i64, ts_ms: i64) -> Event {
    Event {
        ts_ms,
        start_ms,
        processes: Vec::new(),
        detail: EventDetail::Alert {
            rule_id: rule.id,
            rule_name: rule.name.clone(),
            cause: AlertCause::Threshold {
                metric: CPU,
                labels: Labels::default(),
                value: 95.0,
                op: Cmp::Gt,
                threshold: 80.0,
                for_secs: rule.for_secs,
            },
        },
    }
}

fn history_with_firing(dir: &Path, event: &Event) -> (HistoryStore, Writer) {
    let history = HistoryStore::open(dir);
    let writer = history.register_host(&record()).unwrap();
    writer.record_event(HOST, event).unwrap();
    writer.flush().unwrap();
    (history, writer)
}

fn rules_in(answer: Answer) -> HostAlertRules {
    let Answer::AlertRules(rules) = answer else {
        panic!("expected alert rules, got {answer:?}");
    };
    rules
}

async fn expect_frame(subscriber: &mut Subscriber, ts_ms: i64) {
    tokio::time::timeout(WAIT, async {
        loop {
            match subscriber.recv().await.unwrap() {
                BusMsg::Frame(frame) => {
                    assert_eq!(frame.ts_ms, ts_ms);
                    assert_eq!(frame.values.as_ref(), &[95.0]);
                    break;
                }
                BusMsg::Event(event) => panic!("unexpected event before {ts_ms}: {event:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("fake tick should publish a frame");
}

async fn tick(clock: &FakeClock, subscriber: &mut Subscriber) -> i64 {
    assert!(clock.tick());
    let ts_ms = clock.now().wall_ms;
    expect_frame(subscriber, ts_ms).await;
    ts_ms
}

fn stop_and_read_events(host: &AgentHost, subscriber: &mut Subscriber) -> Vec<Event> {
    host.stop();
    std::iter::from_fn(|| subscriber.try_recv())
        .filter_map(|msg| match msg {
            BusMsg::Event(event) => Some((*event).clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn start_restores_cooldown_from_recent_history() {
    if crate::test_support::reexec_for_lock_test() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (ticker, ready) = TestTicker::new();
    let clock = ticker.clock.clone();
    let mut settings = Settings::agent_default();
    let rule = rule(0);
    let fired_at = clock.now().wall_ms - 10_000;
    let previous = firing(&rule, fired_at, fired_at);
    settings.alerts.rules.push(rule);
    let (history, writer) = history_with_firing(dir.path(), &previous);
    let seed = history.recent_alerts(HOST, clock.now().wall_ms, &settings.alerts);
    assert_eq!(seed, std::slice::from_ref(&previous));
    let host =
        AgentHost::start(record(), settings, Some(writer), ticker.parts(), None, seed).unwrap();
    ready.recv_timeout(WAIT).unwrap();
    let mut subscriber = host.hub().subscribe();
    tick(&clock, &mut subscriber).await;
    let last = tick(&clock, &mut subscriber).await;
    assert_eq!(stop_and_read_events(&host, &mut subscriber), []);
    assert_eq!(
        history.alerts_since(HOST, fired_at, last).unwrap(),
        [previous]
    );
}

#[tokio::test]
async fn attach_history_seeds_cooldown_before_the_first_recorded_tick() {
    if crate::test_support::reexec_for_lock_test() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (ticker, ready) = TestTicker::new();
    let clock = ticker.clock.clone();
    let tick_on_store = ticker.tick_on_read.clone();
    let mut settings = Settings::agent_default();
    let rule = rule(0);
    let fired_at = clock.now().wall_ms - 10_000;
    let previous = firing(&rule, fired_at, fired_at);
    settings.alerts.rules.push(rule);
    let (history, writer) = history_with_firing(dir.path(), &previous);
    let host = AgentHost::start(
        record(),
        settings,
        None,
        ticker.parts(),
        Some(dir.path().into()),
        vec![],
    )
    .unwrap();
    ready.recv_timeout(WAIT).unwrap();
    let mut subscriber = host.hub().subscribe();

    // Queue a qualifying tick from inside SetStore, before its acknowledgement.
    // A seed queued after SetStore would arrive behind that tick.
    tick_on_store.store(true, Ordering::Relaxed);
    host.attach_history(&history, writer);
    expect_frame(&mut subscriber, clock.now().wall_ms).await;
    let last = tick(&clock, &mut subscriber).await;
    assert_eq!(stop_and_read_events(&host, &mut subscriber), []);
    assert_eq!(
        history.alerts_since(HOST, fired_at, last).unwrap(),
        [previous]
    );
}

#[tokio::test]
async fn setting_alert_rules_saves_and_applies_the_rule_to_the_running_engine() {
    if crate::test_support::reexec_for_lock_test() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let history = HistoryStore::open(dir.path());
    let writer = history.register_host(&record()).unwrap();
    let (ticker, ready) = TestTicker::new();
    let clock = ticker.clock.clone();
    let first = clock.now().wall_ms;
    let host = AgentHost::start(
        record(),
        Settings::agent_default(),
        Some(writer),
        ticker.parts(),
        Some(dir.path().into()),
        vec![],
    )
    .unwrap();
    ready.recv_timeout(WAIT).unwrap();
    let mut subscriber = host.hub().subscribe();
    tick(&clock, &mut subscriber).await;
    tick(&clock, &mut subscriber).await;

    let current = rules_in(ServedHost::alert_rules(&*host));
    assert!(current.rules.is_empty());
    let rule = rule(2);
    let rules = vec![RuleEntry::Known(rule.clone())];
    let saved = rules_in(ServedHost::set_alert_rules(
        &*host,
        current.revision,
        rules.clone(),
        vec![],
    ));
    assert_eq!(saved.rules, rules);
    assert_eq!(ServedHost::alert_rules(&*host), Answer::AlertRules(saved));
    assert_eq!(
        crate::settings::load(dir.path()).alerts.rules,
        std::slice::from_ref(&rule)
    );

    let start = tick(&clock, &mut subscriber).await;
    let fired_at = tick(&clock, &mut subscriber).await;
    let event = firing(&rule, start, fired_at);
    assert_eq!(
        stop_and_read_events(&host, &mut subscriber),
        std::slice::from_ref(&event)
    );
    assert_eq!(
        history.alerts_since(HOST, first, fired_at).unwrap(),
        [event]
    );
}

#[test]
fn a_host_without_a_rule_store_returns_the_shared_query_refusal() {
    let (ticker, ready) = TestTicker::new();
    let host = AgentHost::start(
        record(),
        Settings::agent_default(),
        None,
        ticker.parts(),
        None,
        vec![],
    )
    .unwrap();
    ready.recv_timeout(WAIT).unwrap();
    let expected = statglass_remote::unsupported_query();
    assert_eq!(ServedHost::alert_rules(&*host), expected);
    assert_eq!(
        ServedHost::set_alert_rules(&*host, 0, vec![], vec![]),
        expected
    );
}
