use crate::live::LiveRegistry;
use statglass_schema::lock::LockExt;
use std::sync::{Arc, Mutex};

#[test]
fn live_visibility_events_only_reach_the_window_that_changed() {
    let registry = LiveRegistry::new();
    let events = Arc::new(Mutex::new(Vec::new()));
    let received = events.clone();
    registry.set_visibility_emitter(move |label, event| {
        received.lock_ok().push((label.to_string(), event.visible));
    });
    assert!(!registry.is_visible("dashboard"));
    registry.window_visible("dashboard", false);
    registry.window_visible("dashboard", true);
    registry.window_visible("dashboard", true);
    registry.window_visible("popover", true);
    registry.window_visible("dashboard", false);
    assert_eq!(
        *events.lock_ok(),
        vec![
            ("dashboard".into(), true),
            ("popover".into(), true),
            ("dashboard".into(), false),
        ]
    );
    assert!(!registry.is_visible("dashboard"));
    assert!(registry.is_visible("popover"));
    assert!(!registry.is_visible("onboarding"));
}

#[test]
fn a_slow_observer_does_not_hold_the_window_registry_lock() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::Duration;
    struct Feed(Arc<dyn Fn(bool) + Send + Sync>);
    impl super::RecentFeed for Feed {
        fn set_recent_interest(&self, on: bool) {
            (self.0)(on);
        }
    }
    for boundary in ["observer", "emitter", "source"] {
        let registry = Arc::new(LiveRegistry::new());
        let (started, ready) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let once = AtomicBool::new(false);
        let wait = Mutex::new(wait);
        let slow = move || {
            if !once.swap(true, Ordering::SeqCst) {
                started.send(()).unwrap();
                wait.lock_ok().recv().unwrap();
            }
        };
        if boundary == "emitter" {
            registry.set_visibility_emitter(move |_, _| slow());
        } else {
            // Registration invokes the observer immediately; arm only once visible.
            let observer = Arc::new(move |on| {
                if on {
                    slow();
                }
            });
            if boundary == "source" {
                registry.register_recent_source(
                    statglass_schema::HostId(uuid::Uuid::nil()),
                    Arc::new(Feed(observer)),
                );
            } else {
                registry.observe_hosts_recent_interest(observer);
            }
            registry.set_hosts_recent_interest("dashboard", true);
        }
        let first = registry.clone();
        let blocked = std::thread::spawn(move || first.window_visible("dashboard", true));
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let other = registry.clone();
        let (done, completed) = mpsc::channel();
        let second = std::thread::spawn(move || {
            other.window_visible("popover", true);
            done.send(()).unwrap();
        });
        let result = completed.recv_timeout(Duration::from_secs(2));
        release.send(()).unwrap();
        blocked.join().unwrap();
        second.join().unwrap();
        result.expect("another window must update while an observer is blocked");
        assert!(registry.is_visible("popover"));
    }
}

#[test]
fn delayed_show_cannot_restore_recent_interest_or_visibility_after_hide() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::Duration;
    struct Feed(AtomicBool);
    impl super::RecentFeed for Feed {
        fn set_recent_interest(&self, on: bool) {
            self.0.store(on, Ordering::SeqCst);
        }
    }
    let registry = Arc::new(LiveRegistry::new());
    let feed = Arc::new(Feed(AtomicBool::new(false)));
    registry.register_recent_source(statglass_schema::HostId(uuid::Uuid::nil()), feed.clone());
    registry.set_hosts_recent_interest("dashboard", true);
    let events = Arc::new(Mutex::new(Vec::new()));
    let received = events.clone();
    registry.set_visibility_emitter(move |_, event| {
        received.lock_ok().push(event.visible);
    });
    let (started, ready) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let wait = Mutex::new(wait);
    registry.observe_hosts_recent_interest(Arc::new(move |on| {
        if on {
            started.send(()).unwrap();
            wait.lock_ok().recv().unwrap();
        }
    }));
    let showing = registry.clone();
    let task = std::thread::spawn(move || showing.window_visible("dashboard", true));
    ready.recv_timeout(Duration::from_secs(2)).unwrap();
    registry.window_visible("dashboard", false);
    assert!(!registry.is_visible("dashboard"));
    release.send(()).unwrap();
    task.join().unwrap();
    assert!(
        !feed.0.load(Ordering::SeqCst),
        "a delayed show must not re-enable a hidden host's recent polling"
    );
    assert_eq!(
        *events.lock_ok(),
        vec![true, false],
        "visibility notifications must preserve native order"
    );
}
