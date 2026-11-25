use tokio::time::timeout;

use crate::lifecycle::Lifecycle;
use crate::sessions::tests::{Fixture, WAIT, host};

#[tokio::test(start_paused = true)]
async fn foreground_during_host_replacement_still_allows_the_new_session_to_park() {
    let original = host(1);
    let mut replacement = original.clone();
    replacement.targets[0].host = "replacement.local".into();
    let mut fixture = Fixture::start(vec![original.clone()]);
    let lifecycle = Lifecycle::new();
    let mut old = fixture.next_dial().await;
    old.handshake(&original).await;

    fixture
        .sessions
        .set_hosts(vec![replacement.clone()])
        .unwrap();
    timeout(WAIT, &mut old.closing).await.unwrap().unwrap();
    lifecycle.resume(&fixture.sessions);
    assert!(fixture.dials.try_recv().is_err());
    old.finish_close.send(()).unwrap();

    let mut new = fixture.next_dial().await;
    if new.target == original.targets[0].host {
        let resumed = new;
        new = fixture.next_dial().await;
        assert!(
            resumed.finish_close.is_closed(),
            "replacement waited for the old runner"
        );
    }
    assert_eq!(new.target, replacement.targets[0].host);
    new.handshake(&replacement).await;

    let quiesced = lifecycle.quiesce(&fixture.sessions);
    timeout(WAIT, &mut new.closing).await.unwrap().unwrap();
    new.finish_close.send(()).unwrap();
    timeout(WAIT, quiesced).await.unwrap();
}
