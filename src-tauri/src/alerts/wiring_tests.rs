//! What happens when an alert fires, through sinks that record each step, and when
//! the host-offline poll observes at all.

use std::sync::Mutex;

use statglass_schema::{AlertCause, AlertRule, Event, EventDetail, HostId};
use uuid::Uuid;

use super::fire::{AlertSinks, announce, record_and_announce};
use super::host_poll::{MAX_STEP_MS, OFFLINE_AFTER_MS, POLL_PERIOD, should_watch};

/// One step a sink took, with the event's time.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    Record(i64),
    Notify(i64),
    Deliver(i64),
    Publish(i64),
}

/// Sinks that remember what they were asked to do; `record` fails when told to.
#[derive(Default)]
struct Recorded {
    steps: Mutex<Vec<Step>>,
    store_fails: bool,
}

impl Recorded {
    fn push(&self, step: Step) {
        self.steps.lock().unwrap().push(step);
    }
    fn steps(&self) -> Vec<Step> {
        std::mem::take(&mut *self.steps.lock().unwrap())
    }
}

impl AlertSinks for Recorded {
    fn record(&self, event: &Event) -> anyhow::Result<()> {
        if self.store_fails {
            anyhow::bail!("history unavailable");
        }
        self.push(Step::Record(event.ts_ms));
        Ok(())
    }
    fn notify(&self, event: &Event) {
        self.push(Step::Notify(event.ts_ms));
    }
    fn deliver(&self, event: &Event) {
        self.push(Step::Deliver(event.ts_ms));
    }
    fn publish(&self, event: &Event) {
        self.push(Step::Publish(event.ts_ms));
    }
}

fn host_offline_alert() -> Event {
    Event {
        ts_ms: 1_800_000_300_000,
        start_ms: 1_800_000_000_000,
        processes: vec![],
        detail: EventDetail::Alert {
            rule_id: AlertRule::HOST_OFFLINE_ID,
            rule_name: "Saved host offline".into(),
            cause: AlertCause::HostOffline {
                host: HostId(Uuid::from_u128(0xb0)),
                name: "m1-linux".into(),
            },
        },
    }
}

#[test]
fn a_host_offline_alert_is_recorded_then_notified_delivered_and_published() {
    let sinks = Recorded::default();
    let event = host_offline_alert();
    record_and_announce(&sinks, &event);
    let t = event.ts_ms;
    assert_eq!(
        sinks.steps(),
        [
            Step::Record(t),
            Step::Notify(t),
            Step::Deliver(t),
            Step::Publish(t)
        ]
    );
}

#[test]
fn an_alert_the_store_cannot_take_still_goes_out() {
    let sinks = Recorded {
        store_fails: true,
        ..Recorded::default()
    };
    let event = host_offline_alert();
    record_and_announce(&sinks, &event);
    let t = event.ts_ms;
    assert_eq!(
        sinks.steps(),
        [Step::Notify(t), Step::Deliver(t), Step::Publish(t)]
    );
}

#[test]
fn an_engine_alert_is_announced_without_recording_it_again() {
    let sinks = Recorded::default();
    let event = host_offline_alert();
    announce(&sinks, &event);
    let t = event.ts_ms;
    assert_eq!(
        sinks.steps(),
        [Step::Notify(t), Step::Deliver(t), Step::Publish(t)]
    );
}

#[test]
fn the_poll_observes_only_with_the_rule_on_and_a_host_saved() {
    assert!(should_watch(true, 1));
    assert!(should_watch(true, 3));
    assert!(!should_watch(false, 1));
    assert!(!should_watch(true, 0));
    assert!(!should_watch(false, 0));
}

#[test]
fn the_poll_waits_five_minutes_and_bridges_at_most_three_polls() {
    assert_eq!(OFFLINE_AFTER_MS, 300_000);
    assert_eq!(POLL_PERIOD.as_millis(), 30_000);
    assert_eq!(MAX_STEP_MS, 3 * 30_000);
}
