use tokio::time::timeout;

use crate::lifecycle::Lifecycle;
use crate::sessions::tests::{Fixture, WAIT, host};

use super::*;

#[tokio::test(start_paused = true)]
async fn foreground_during_budget_rebuild_finishes_retiring_and_can_park_again() {
    let hosts: Vec<_> = (1..=11).map(host).collect();
    let mut fixture = Fixture::start(hosts[..2].to_vec(), SyncPolicy::Off);
    let registry = fixture.sessions.registry.clone();
    let lifecycle = Lifecycle::new();
    let mut old = Vec::new();
    for _ in 0..2 {
        let mut dial = fixture.next_dial().await;
        let host = hosts[..2]
            .iter()
            .find(|host| host.targets[0].host == dial.target)
            .unwrap();
        dial.handshake(host).await;
        old.push((registry.entry(host.id).unwrap(), dial));
    }

    fixture.sessions.set_hosts(hosts.clone()).unwrap();
    for (_, dial) in &mut old {
        timeout(WAIT, &mut dial.closing)
            .await
            .expect("retiring session begins its orderly close")
            .expect("retiring session was stopped before closing its transport");
    }
    lifecycle.resume(&fixture.sessions);
    for (entry, _) in &old {
        assert!(
            entry.mirror.store().is_available(),
            "old mirror is still open"
        );
    }

    let mut replacements = Vec::new();
    for _ in 0..9 {
        let dial = fixture.next_dial().await;
        assert!(old.iter().all(|(_, old)| old.target != dial.target));
        replacements.push(dial);
    }
    for (entry, dial) in old {
        dial.finish_close.send(()).unwrap();
        let (installed, replacement) = loop {
            let mut candidate = fixture.next_dial().await;
            assert_eq!(candidate.target, dial.target);
            if let Ok(installed) = registry.entry(entry.config.id)
                && !Arc::ptr_eq(&installed, &entry)
                && !candidate.finish_close.is_closed()
            {
                break (installed, candidate);
            }
            // Resume can start a dial before retirement stops the old runner.
            timeout(WAIT, candidate.finish_close.closed())
                .await
                .expect("the old runner's resumed dial was cancelled");
        };
        assert_eq!(installed.policy.budget_mb(), 22);
        assert!(!entry.mirror.store().is_available(), "old mirror closed");
        assert!(
            installed.mirror.store().is_available(),
            "replacement reopened mirror"
        );
        replacements.push(replacement);
    }
    assert!(
        registry
            .state
            .lock_ok()
            .run
            .as_ref()
            .unwrap()
            .retiring
            .is_empty()
    );
    assert!(
        fixture.dials.try_recv().is_err(),
        "only the installed sources are dialing"
    );

    for dial in &mut replacements {
        let host = hosts
            .iter()
            .find(|host| host.targets[0].host == dial.target)
            .unwrap();
        dial.handshake(host).await;
    }
    let quiesced = lifecycle.quiesce(&fixture.sessions);
    for mut dial in replacements {
        timeout(WAIT, &mut dial.closing).await.unwrap().unwrap();
        dial.finish_close.send(()).unwrap();
    }
    timeout(WAIT, quiesced)
        .await
        .expect("all replacement sources drained");
}
