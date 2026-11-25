//! Catch-up plans are stream facts, including a first catch-up deferred until show.
use super::*;

fn plans(msgs: &[LiveMsg]) -> Vec<(u32, Option<i64>)> {
    msgs.iter()
        .filter_map(|m| match m {
            LiveMsg::BackfillPlan {
                recent_rows,
                earlier_start_ms,
            } => Some((*recent_rows, *earlier_start_ms)),
            _ => None,
        })
        .collect()
}

fn seeded(rows: i64) -> (Arc<FakeFeed>, Arc<FrameLayout>) {
    let feed = FakeFeed::new();
    let l = layout(1, 1);
    for i in 1..=rows {
        feed.tick(&l, i * 1000, 1.0);
    }
    (feed, l)
}

fn plan_precedes_rows(msgs: &[LiveMsg]) {
    let plan = msgs
        .iter()
        .position(|m| matches!(m, LiveMsg::BackfillPlan { .. }))
        .unwrap();
    let rows = msgs
        .iter()
        .position(|m| matches!(m, LiveMsg::Backfill { .. }))
        .unwrap();
    assert!(plan < rows);
}

#[tokio::test(start_paused = true)]
async fn fresh_catch_up_announces_recent_rows_and_the_oldest_earlier_chunk() {
    let (feed, _) = seeded(1500);
    let reg = registry(&["main"]);
    let (s, rx, _) = sink();
    reg.subscribe("main", feed, s, req(3_600_000)).unwrap();
    let mut msgs = drain_raw(&rx).await;
    plan_precedes_rows(&msgs);
    tokio::time::advance(EARLIER_AFTER).await;
    msgs.extend(drain_raw(&rx).await);
    let recent = msgs
        .iter()
        .filter_map(|m| match m {
            LiveMsg::Backfill { rows, .. } => Some(rows.len() as u32),
            _ => None,
        })
        .sum();
    let first = msgs
        .iter()
        .filter_map(|m| match m {
            LiveMsg::BackfillEarlier { start_ms, .. } => Some(*start_ms),
            _ => None,
        })
        .min();
    assert_eq!(plans(&msgs), [(recent, first)]);
    assert_eq!(first, Some(1000));
}

#[tokio::test(start_paused = true)]
async fn short_catch_up_has_no_earlier_history() {
    let (feed, _) = seeded(60);
    let reg = registry(&["main"]);
    let (s, rx, _) = sink();
    reg.subscribe("main", feed, s, req(3_600_000)).unwrap();
    let msgs = drain_raw(&rx).await;
    assert_eq!(plans(&msgs), [(60, None)]);
    plan_precedes_rows(&msgs);
}

#[tokio::test(start_paused = true)]
async fn hidden_first_subscribe_waits_for_show_to_plan_and_backfill() {
    let (feed, _) = seeded(300);
    let reg = registry(&[]);
    let (s, rx, _) = sink();
    let info = reg.subscribe("main", feed, s, req(3_600_000)).unwrap();
    assert_eq!(info.backfill_rows, 0);
    let hidden = drain_raw(&rx).await;
    assert!(plans(&hidden).is_empty());
    assert!(!hidden.iter().any(|m| matches!(m, LiveMsg::Backfill { .. })));
    reg.window_visible("main", true);
    let shown = drain_raw(&rx).await;
    assert_eq!(plans(&shown), [(121, Some(1000))]);
    plan_precedes_rows(&shown);
}

#[tokio::test(start_paused = true)]
async fn hiding_sends_the_promised_earlier_chunks_at_once() {
    let (feed, l) = seeded(1500);
    let reg = registry(&["main"]);
    let (s, rx, _) = sink();
    let info = reg
        .subscribe("main", feed.clone(), s, req(3_600_000))
        .unwrap();
    assert!(info.earlier_rows > 0);
    let before = drain_raw(&rx).await;
    assert!(
        !before
            .iter()
            .any(|m| matches!(m, LiveMsg::BackfillEarlier { .. }))
    );
    // Hidden before `EARLIER_AFTER` has passed.
    reg.window_visible("main", false);
    let hidden = drain_raw(&rx).await;
    let rows: usize = hidden
        .iter()
        .filter_map(|m| match m {
            LiveMsg::BackfillEarlier { rows, .. } => Some(rows.len()),
            _ => None,
        })
        .sum();
    assert_eq!(rows, info.earlier_rows as usize);
    let mut floor = before
        .iter()
        .find_map(|m| match m {
            LiveMsg::Backfill { start_ms, .. } => Some(*start_ms),
            _ => None,
        })
        .unwrap();
    for message in &hidden {
        match message {
            LiveMsg::BackfillEarlier { start_ms, .. } => {
                assert!(*start_ms < floor);
                floor = *start_ms;
            }
            LiveMsg::Frame { .. } | LiveMsg::Backfill { .. } => panic!("rows sent on hide"),
            _ => {}
        }
    }
    feed.tick(&l, 1_501_000, 2.0);
    reg.window_visible("main", true);
    let shown = drain_raw(&rx).await;
    assert!(shown.iter().any(|m| matches!(m, LiveMsg::Backfill { .. })));
    for message in shown {
        match message {
            LiveMsg::BackfillPlan { .. } | LiveMsg::BackfillEarlier { .. } => {
                panic!("history restarted on show")
            }
            LiveMsg::Backfill { start_ms, .. } => assert!(start_ms > 1_500_000),
            _ => {}
        }
    }
}

#[tokio::test(start_paused = true)]
async fn plain_resume_does_not_plan_again() {
    let (feed, l) = seeded(60);
    let reg = registry(&["main"]);
    let (s, rx, _) = sink();
    reg.subscribe("main", feed.clone(), s, req(3_600_000))
        .unwrap();
    drain_raw(&rx).await;
    reg.window_visible("main", false);
    settle().await;
    feed.tick(&l, 61_000, 1.0);
    reg.window_visible("main", true);
    let msgs = drain_raw(&rx).await;
    assert!(plans(&msgs).is_empty());
    assert!(msgs.iter().any(|m| matches!(m, LiveMsg::Backfill { .. })));
}

#[tokio::test(start_paused = true)]
async fn clock_step_cancels_the_promised_earlier_chunks() {
    let (feed, l) = seeded(1500);
    let reg = registry(&["main"]);
    let (s, rx, _) = sink();
    reg.subscribe("main", feed.clone(), s, req(3_600_000))
        .unwrap();
    assert_eq!(plans(&drain_raw(&rx).await), [(121, Some(1000))]);
    feed.step();
    feed.tick(&l, 500_000, 2.0);
    let mut msgs = drain_raw(&rx).await;
    plan_precedes_rows(&msgs);
    assert_eq!(plans(&msgs), [(1, None)]);
    tokio::time::advance(EARLIER_AFTER).await;
    msgs.extend(drain_raw(&rx).await);
    assert!(
        !msgs
            .iter()
            .any(|m| matches!(m, LiveMsg::BackfillEarlier { .. }))
    );
}

#[tokio::test(start_paused = true)]
async fn no_anchor_sends_no_plan_but_an_anchored_window_does() {
    let (feed, l) = seeded(0);
    let reg = registry(&["main"]);
    let (s, rx, _) = sink();
    reg.subscribe("main", feed.clone(), s, req(0)).unwrap();
    assert!(plans(&drain_raw(&rx).await).is_empty());
    feed.tick(&l, 1000, 1.0);
    let (s, rx, _) = sink();
    reg.subscribe("main", feed, s, req(0)).unwrap();
    assert_eq!(plans(&drain_raw(&rx).await), [(1, None)]);
}

#[tokio::test(start_paused = true)]
async fn hiding_while_display_idle_still_drains_promised_chunks() {
    let (feed, _) = seeded(1500);
    let reg = registry(&["main"]);
    let (s, rx, _) = sink();
    let info = reg
        .subscribe("main", feed.clone(), s, req(3_600_000))
        .unwrap();
    drain_raw(&rx).await;
    feed.set_status(|s| s.display_idle = true);
    let idle = drain_raw(&rx).await;
    assert!(
        idle.iter()
            .any(|m| matches!(m, LiveMsg::Status(s) if s.display_idle))
    );
    reg.window_visible("main", false);
    let hidden = drain_raw(&rx).await;
    let rows: usize = hidden
        .iter()
        .filter_map(|m| match m {
            LiveMsg::BackfillEarlier { rows, .. } => Some(rows.len()),
            _ => None,
        })
        .sum();
    assert!(rows > 0);
    assert_eq!(rows, info.earlier_rows as usize);
    assert!(
        !hidden
            .iter()
            .any(|m| matches!(m, LiveMsg::Frame { .. } | LiveMsg::Backfill { .. }))
    );
}
