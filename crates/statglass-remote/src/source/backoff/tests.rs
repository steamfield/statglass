use super::*;

#[test]
fn delays_double_from_one_second_to_a_sixty_second_cap() {
    let mut backoff = Backoff::new();
    let delays: Vec<u64> = (0..9).map(|_| backoff.fail().as_secs()).collect();
    assert_eq!(delays, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
    assert_eq!(backoff.attempt(), 9);
}

#[test]
fn reset_starts_over_at_one_second() {
    let mut backoff = Backoff::new();
    backoff.fail();
    backoff.fail();
    backoff.fail();
    backoff.reset();
    assert_eq!(backoff.attempt(), 0);
    assert_eq!(backoff.fail(), Duration::from_secs(1));
    assert_eq!(backoff.attempt(), 1);
}

#[test]
fn many_failures_never_overflow() {
    let mut backoff = Backoff::new();
    for _ in 0..1_000 {
        assert!(backoff.fail() <= Duration::from_secs(60));
    }
    assert_eq!(backoff.attempt(), 1_000);
}
