#![allow(clippy::too_many_lines)] // Integration scenarios keep setup and assertions together.
//! In-process sync (architecture.md infra 3 and 4): store A (an agent's database) syncs
//! into store B (a controller's) through the cursor API, with every request and reply
//! encoded and decoded as real `statglass-proto` messages. Covers paging, a replayed page,
//! a cursor that pruning passed (a `truncated` gap row), a wiped agent database (new
//! epoch, full resync), and row kinds gated on the negotiated features (D-064).

// clippy.toml allows unwrap inside #[test] functions only; the helpers in this test-only
// file panic on failure by design.
#![allow(clippy::unwrap_used)]

mod common;

use std::collections::BTreeSet;
use std::sync::{Arc, mpsc};
use std::time::Duration;

use common::*;
use statglass_proto::{
    Hello, Message, Offer, SyncPage, SyncRequest, WireBucket, WireEvent, WireGap, WireLayout,
    decode_message, encode_message, local_features, negotiate,
};
use statglass_schema::{
    AlertCause, Capabilities, Cmp, Event, EventDetail, Gap, GapReason, HostRecord, Labels,
    MetricId, Module, SeriesKey, SeriesSelector, SyncKinds, SyncRowKind, Tier,
};
use statglass_store::{
    CursorPage, CursorRead, HistoryQuery, HistoryResult, IngestReport, PageEvent, PageGap,
    PageLayout, PageRow, Reader, Retention, Store, StoreError, TierChoice,
    docker::{DockerBatch, DockerEntity, DockerOutcome},
    usage::{UsageBucket, UsageSourceCoverage},
};
use tracing::{Level, Metadata, Subscriber, field, span};
use uuid::Uuid;

/// Every message crosses the codec, as it would over SSH.
fn wire(msg: Message) -> Message {
    decode_message(&encode_message(&msg).unwrap()).unwrap()
}

fn to_message(read: CursorRead) -> Message {
    match read {
        CursorRead::Page(p) => Message::SyncPage(SyncPage {
            tier: p.tier,
            epoch: p.epoch,
            layouts: p
                .layouts
                .into_iter()
                .map(|l| WireLayout {
                    layout_no: l.layout_no,
                    series: l.series,
                })
                .collect(),
            rows: p
                .rows
                .into_iter()
                .map(|r| WireBucket {
                    seq: r.seq,
                    bucket_ts: r.bucket_ts,
                    layout_no: r.layout_no,
                    stats: r.stats,
                })
                .collect(),
            gaps: p
                .gaps
                .into_iter()
                .map(|g| WireGap {
                    source_id: g.source_id,
                    seq: g.seq,
                    start_ms: g.gap.start_ms,
                    end_ms: g.gap.end_ms,
                    module: g.gap.module,
                    reason: g.gap.reason,
                })
                .collect(),
            events: p
                .events
                .into_iter()
                .map(|e| WireEvent {
                    source_id: e.source_id,
                    seq: e.seq,
                    ts_ms: e.ts_ms,
                    kind: e.kind,
                    payload: e.payload,
                })
                .collect(),
            last_seq: p.last_seq,
            more: p.more,
        }),
        CursorRead::Truncated {
            tier,
            earliest_ts_ms,
            epoch,
        } => Message::Truncated {
            tier,
            earliest_ts_ms,
            epoch,
        },
    }
}

/// The receiver rebuilds a page; `kinds` is what it negotiated, which it stores with the
/// cursor (it does not travel).
fn from_wire(p: SyncPage, kinds: SyncKinds) -> CursorPage {
    CursorPage {
        tier: p.tier,
        epoch: p.epoch,
        kinds,
        layouts: p
            .layouts
            .into_iter()
            .map(|l| PageLayout {
                layout_no: l.layout_no,
                series: l.series,
            })
            .collect(),
        rows: p
            .rows
            .into_iter()
            .map(|r| PageRow {
                seq: r.seq,
                bucket_ts: r.bucket_ts,
                layout_no: r.layout_no,
                stats: r.stats,
            })
            .collect(),
        gaps: p
            .gaps
            .into_iter()
            .map(|g| PageGap {
                source_id: g.source_id,
                seq: g.seq,
                gap: Gap {
                    start_ms: g.start_ms,
                    end_ms: g.end_ms,
                    module: g.module,
                    reason: g.reason,
                },
            })
            .collect(),
        events: p
            .events
            .into_iter()
            .map(|e| PageEvent {
                source_id: e.source_id,
                seq: e.seq,
                ts_ms: e.ts_ms,
                kind: e.kind,
                payload: e.payload,
            })
            .collect(),
        last_seq: p.last_seq,
        more: p.more,
    }
}

/// The agent's `Hello`, through the codec. The controller learns the host and the epoch
/// from it. A current build offers every row kind.
fn hello(agent: &Store, record: &HostRecord) -> Hello {
    hello_with(agent, record, local_features())
}

fn hello_with(agent: &Store, record: &HostRecord, features: BTreeSet<String>) -> Hello {
    let msg = wire(Message::Hello(Box::new(Hello {
        proto_version: statglass_proto::PROTO_VERSION,
        min_compatible: statglass_proto::MIN_COMPATIBLE,
        app_version: "1.0.0".into(),
        host: record.identity(),
        db_instance_uuid: agent.epoch(),
        capabilities: Capabilities::default(),
        features,
    })));
    let Message::Hello(h) = msg else {
        panic!("not a hello");
    };
    *h
}

/// What one sync run did, for assertions.
#[derive(Debug, Default)]
struct Run {
    requests: Vec<SyncRequest>,
    pages: Vec<SyncPage>,
    truncations: Vec<(i64, Option<Gap>)>,
}

/// Syncs `tier` of the agent's host into the controller until a page says `more: false`,
/// with the row kinds a current controller negotiates with `h`.
fn sync(agent: &mut Reader, controller: &Store, h: &Hello, tier: Tier, max_rows: u32) -> Run {
    let ours = Offer::local(local_features());
    let kinds = negotiate(&ours, &Offer::from(h)).unwrap().sync_kinds();
    sync_kinds(agent, controller, h, tier, max_rows, kinds)
}

/// [`sync`] with the negotiated row kinds given: what an older controller would agree on.
fn sync_kinds(
    agent: &mut Reader,
    controller: &Store,
    h: &Hello,
    tier: Tier,
    max_rows: u32,
    kinds: SyncKinds,
) -> Run {
    let host = h.host.id;
    let mut run = Run::default();
    let mut ctl = controller.reader().unwrap();
    for _ in 0..1000 {
        let after = ctl
            .resume_cursor(host, tier, h.db_instance_uuid, kinds)
            .unwrap();
        let Message::SyncRequest(req) = wire(Message::SyncRequest(SyncRequest {
            from_ms: None,
            max_bytes: None,
            tier,
            after,
            max_rows,
        })) else {
            panic!("not a request");
        };
        run.requests.push(req.clone());
        let reply = agent
            .read_after(host, req.tier, req.after, req.max_rows, kinds)
            .unwrap();
        match wire(to_message(reply)) {
            Message::SyncPage(page) => {
                run.pages.push(page.clone());
                let more = page.more;
                controller
                    .writer()
                    .ingest_page(host, from_wire(page, kinds))
                    .unwrap();
                controller.writer().flush().unwrap();
                if !more {
                    return run;
                }
            }
            Message::Truncated {
                tier,
                earliest_ts_ms,
                epoch,
            } => {
                assert_eq!(epoch, h.db_instance_uuid);
                let gap = controller
                    .writer()
                    .record_truncation(host, tier, earliest_ts_ms)
                    .unwrap();
                controller.writer().flush().unwrap();
                run.truncations.push((earliest_ts_ms, gap));
            }
            other => panic!("unexpected reply {other:?}"),
        }
    }
    panic!("sync did not finish");
}

fn all_series(host: statglass_schema::HostId, from: i64, to: i64, tier: Tier) -> HistoryQuery {
    let selectors = ["cpu.total", "cpu.load", "mem.used", "disk.read"]
        .into_iter()
        .map(|m| SeriesSelector {
            metric: MetricId::from_static(m),
            labels: Labels::new(),
        })
        .collect();
    HistoryQuery {
        host,
        selectors,
        from_ms: from,
        to_ms: to,
        tier: TierChoice::Fixed(tier),
        max_points: 100_000,
    }
}

fn history(store: &Store, q: &HistoryQuery) -> HistoryResult {
    store.reader().unwrap().history(q).unwrap()
}

/// Writes `minutes` of M1 buckets (and 10 s buckets for the first of them) from
/// `start`, switching layout halfway, as an engine would.
fn fill(agent: &Store, h: &HostRecord, start: i64, minutes: i64) {
    let w = agent.writer();
    let small = layout(&["cpu.total", "cpu.load{core=P0}", "mem.used"]);
    let big: Arc<[SeriesKey]> = layout(&[
        "cpu.total",
        "cpu.load{core=P0}",
        "mem.used",
        "disk.read{dev=disk4}",
    ]);
    for i in 0..minutes {
        let l = if i < minutes / 2 { &small } else { &big };
        let ts = start + i * MIN;
        w.write_bucket(bucket(h.id, Tier::M1, ts, l, (i % 50) as f32))
            .unwrap();
        if i < 10 {
            for s in 0..6 {
                w.write_bucket(bucket(h.id, Tier::S10, ts + s * 10_000, l, s as f32))
                    .unwrap();
            }
        }
    }
    w.flush().unwrap();
}

#[test]
fn agent_syncs_into_controller() {
    let dir = temp_dir("sync");
    let record = host(1);
    let agent = open(&dir, "agent.sqlite");
    let controller = open(&dir, "controller.sqlite");
    let aw = agent.writer();
    aw.upsert_host(record.clone()).unwrap();

    // Two hours of history with a sleep gap, a disabled module and an event.
    fill(&agent, &record, T0, 60);
    aw.write_gap(
        record.id,
        Gap::host(T0 + 60 * MIN, Some(T0 + 70 * MIN), GapReason::Sleep).unwrap(),
    )
    .unwrap();
    fill(&agent, &record, T0 + 70 * MIN, 50);
    aw.write_gap(
        record.id,
        Gap::module_disabled(T0 + 80 * MIN, None, Module::Disk),
    )
    .unwrap();
    aw.write_event(
        record.id,
        T0 + 90 * MIN,
        "fans_ramped",
        vec![0xa1, 0x61, 0x70, 0x01],
    )
    .unwrap();
    aw.flush().unwrap();

    // Handshake: the controller records the agent's host as remote.
    let h = hello(&agent, &record);
    assert_eq!(h.db_instance_uuid, agent.epoch());
    let remote = HostRecord::from_identity(h.host.clone(), false);
    controller.writer().upsert_host(remote).unwrap();

    // --- Initial sync, in pages of 40 ------------------------------------------------
    let mut a = agent.reader().unwrap();
    let run = sync(&mut a, &controller, &h, Tier::M1, 40);
    assert_eq!(run.requests[0].after, None, "no cursor yet: from the start");
    assert!(run.pages.len() >= 3, "{} pages", run.pages.len());
    assert!(
        run.pages
            .iter()
            .all(|p| p.rows.len() + p.gaps.len() + p.events.len() <= 40)
    );
    let s10 = sync(&mut a, &controller, &h, Tier::S10, 100);
    assert!(
        s10.pages.iter().all(|p| p.gaps.is_empty()),
        "gaps ride M1 only"
    );

    let span = (T0 - HOUR, T0 + 3 * HOUR);
    for tier in [Tier::M1, Tier::S10] {
        let q = all_series(record.id, span.0, span.1, tier);
        let (ha, hb) = (history(&agent, &q), history(&controller, &q));
        assert!(!ha.series.is_empty());
        assert_eq!(hb, ha, "{tier:?}: controller shows what the agent has");
    }
    let mut c = controller.reader().unwrap();
    let (cursor, kinds) = c.cursor(record.id, Tier::M1).unwrap().unwrap();
    assert_eq!(kinds, SyncKinds::ALL);
    assert_eq!(cursor.epoch, agent.epoch());
    assert_eq!(cursor.seq, run.pages.last().unwrap().last_seq);
    let ctl_db = raw(&controller);
    assert_eq!(count(&ctl_db, "SELECT count(*) FROM events"), 1);

    // --- A replayed page changes nothing ----------------------------------------------
    let before: Vec<_> = ["tier_1m", "gaps", "events", "cursors", "series", "layouts"]
        .iter()
        .map(|t| dump(&ctl_db, t))
        .collect();
    let replay = from_wire(run.pages[1].clone(), SyncKinds::ALL);
    let report = controller.writer().ingest_page(record.id, replay).unwrap();
    controller.writer().flush().unwrap();
    assert_eq!(report.rows_written, 0);
    assert!(report.rows_unchanged > 0);
    // Replaying an older page moves the cursor back; put it where it was, as a real
    // controller would by applying pages in order.
    let last = from_wire(run.pages.last().unwrap().clone(), SyncKinds::ALL);
    controller.writer().ingest_page(record.id, last).unwrap();
    controller.writer().flush().unwrap();
    let after: Vec<_> = ["tier_1m", "gaps", "events", "cursors", "series", "layouts"]
        .iter()
        .map(|t| dump(&ctl_db, t))
        .collect();
    assert_eq!(after, before, "replay leaves identical rows");

    // --- Incremental sync picks up a closed gap and new rows --------------------------
    aw.close_gap(
        record.id,
        GapReason::ModuleDisabled,
        Some(Module::Disk),
        None,
        T0 + 100 * MIN,
    )
    .unwrap();
    fill(&agent, &record, T0 + 120 * MIN, 10);
    let run = sync(&mut a, &controller, &h, Tier::M1, 1000);
    assert_eq!(run.requests[0].after, Some(cursor));
    assert_eq!(run.pages[0].rows.len(), 10);
    assert_eq!(
        run.pages[0].gaps.len(),
        1,
        "the closed gap is a new version"
    );
    let gaps = c.gaps(record.id, T0, T0 + DAY).unwrap();
    assert_eq!(
        gaps[1],
        Gap::module_disabled(T0 + 80 * MIN, Some(T0 + 100 * MIN), Module::Disk)
    );

    // --- The agent prunes past the controller's cursor --------------------------------
    // The controller goes away; the agent records four more hours and then prunes
    // everything older than two hours.
    fill(&agent, &record, T0 + 130 * MIN, 240);
    let now = T0 + 370 * MIN;
    let retention = Retention {
        s10_ms: HOUR,
        m1_ms: 2 * HOUR,
        history_ms: 2 * HOUR,
        proc_snap_ms: HOUR,
        max_bytes: Retention::DEFAULT_MAX_BYTES,
    };
    aw.prune(now, retention).unwrap();
    let earliest = now - 2 * HOUR;

    let run = sync(&mut a, &controller, &h, Tier::M1, 1000);
    assert_eq!(run.truncations.len(), 1);
    let (ts, gap) = &run.truncations[0];
    assert_eq!(*ts, earliest);
    // The controller's data ends with the bucket at T0 + 129 min.
    let expected = Gap::host(T0 + 130 * MIN, Some(earliest), GapReason::Truncated).unwrap();
    assert_eq!(gap, &Some(expected));
    assert_eq!(
        run.requests[1].after, None,
        "after Truncated: from the start"
    );
    assert!(c.gaps(record.id, T0, now).unwrap().contains(&expected));
    let q = all_series(record.id, earliest, now, Tier::M1);
    assert_eq!(history(&controller, &q), history(&agent, &q));
    // Nothing between the old data and `earliest` was invented.
    let lost = all_series(record.id, T0 + 130 * MIN, earliest, Tier::M1);
    assert!(history(&controller, &lost).series.is_empty());

    // --- The agent's database is wiped: new epoch, full resync ------------------------
    drop(a);
    agent.close().unwrap();
    let agent2 = open(&dir, "agent-reinstalled.sqlite");
    agent2.writer().upsert_host(record.clone()).unwrap();
    fill(&agent2, &record, now, 30);
    let h2 = hello(&agent2, &record);
    assert_ne!(h2.db_instance_uuid, h.db_instance_uuid);
    let mut a2 = agent2.reader().unwrap();
    let run = sync(&mut a2, &controller, &h2, Tier::M1, 1000);
    assert_eq!(
        run.requests[0].after, None,
        "the stored cursor belongs to the old epoch"
    );
    assert!(run.truncations.is_empty());
    assert_eq!(run.pages[0].epoch, h2.db_instance_uuid);
    assert_eq!(
        c.cursor(record.id, Tier::M1).unwrap().unwrap().0.epoch,
        h2.db_instance_uuid
    );
    let q = all_series(record.id, now, now + HOUR, Tier::M1);
    assert_eq!(history(&controller, &q), history(&agent2, &q));
    // History synced before the wipe is still there.
    let old = all_series(record.id, earliest, now, Tier::M1);
    assert!(!history(&controller, &old).series.is_empty());
}

#[test]
fn gaps_for_unknown_modules_are_skipped_on_ingest() {
    let dir = temp_dir("sync-unknown");
    let controller = open(&dir, "controller.sqlite");
    let record = host(5);
    controller.writer().upsert_host(record.clone()).unwrap();
    // A page from a newer agent: one gap for a module this build does not know, one with
    // a reason it does not know.
    let page = SyncPage {
        tier: Tier::M1,
        epoch: Uuid::from_u128(0xE),
        layouts: vec![],
        rows: vec![],
        gaps: vec![
            WireGap {
                source_id: None,
                seq: 1,
                start_ms: T0,
                end_ms: Some(T0 + MIN),
                module: Some(Module::Unknown),
                reason: GapReason::ModuleDisabled,
            },
            WireGap {
                source_id: None,
                seq: 2,
                start_ms: T0,
                end_ms: Some(T0 + MIN),
                module: None,
                reason: GapReason::Unknown,
            },
        ],
        events: vec![],
        last_seq: 2,
        more: false,
    };
    let Message::SyncPage(page) = wire(Message::SyncPage(page)) else {
        panic!("not a page");
    };
    let report = controller
        .writer()
        .ingest_page(record.id, from_wire(page, SyncKinds::ALL))
        .unwrap();
    assert_eq!((report.gaps_written, report.gaps_skipped), (1, 1));
    controller.writer().flush().unwrap();
    let gaps = controller
        .reader()
        .unwrap()
        .gaps(record.id, T0, T0 + MIN)
        .unwrap();
    assert_eq!(gaps.len(), 1);
    assert_eq!(gaps[0].reason, GapReason::Unknown, "kept: still a gap band");
}

/// D-064: a row kind travels only when both sides negotiated it. An older controller
/// that cannot store events offers buckets and gaps only: it gets no events, and its
/// cursor (which moves past the event's `seq`) records the kinds it took. Once it
/// upgrades and negotiates events too, that cursor no longer covers what it wants, so it
/// resyncs from the start and the event arrives. Nothing is lost or duplicated.
#[test]
fn row_kinds_travel_only_when_negotiated() {
    let dir = temp_dir("sync-kinds");
    let record = host(1);
    let agent = open(&dir, "agent.sqlite");
    let controller = open(&dir, "controller.sqlite");
    let aw = agent.writer();
    aw.upsert_host(record.clone()).unwrap();
    fill(&agent, &record, T0, 20);
    aw.write_gap(
        record.id,
        Gap::host(T0 + 20 * MIN, Some(T0 + 25 * MIN), GapReason::Sleep).unwrap(),
    )
    .unwrap();
    aw.write_event(record.id, T0 + 22 * MIN, "fans_ramped", vec![0xa0])
        .unwrap();
    aw.flush().unwrap();
    fill(&agent, &record, T0 + 25 * MIN, 10);
    let event_seq: i64 = raw(&agent)
        .query_row("SELECT seq FROM events", [], |r| r.get(0))
        .unwrap();

    let h = hello(&agent, &record);
    controller
        .writer()
        .upsert_host(HostRecord::from_identity(h.host.clone(), false))
        .unwrap();
    let old_offer = Offer::local(BTreeSet::from([
        "rows.buckets".to_string(),
        "rows.gaps".to_string(),
    ]));
    let old = negotiate(&old_offer, &Offer::from(&h))
        .unwrap()
        .sync_kinds();
    assert!(old.contains(SyncRowKind::Gaps) && !old.contains(SyncRowKind::Events));

    // --- The old controller ------------------------------------------------------------
    let mut a = agent.reader().unwrap();
    let run = sync_kinds(&mut a, &controller, &h, Tier::M1, 1000, old);
    assert!(
        run.pages.iter().all(|p| p.events.is_empty()),
        "not negotiated"
    );
    assert_eq!(run.pages.iter().map(|p| p.gaps.len()).sum::<usize>(), 1);
    let ctl_db = raw(&controller);
    assert_eq!(count(&ctl_db, "SELECT count(*) FROM events"), 0);
    let mut c = controller.reader().unwrap();
    let (cursor, stored) = c.cursor(record.id, Tier::M1).unwrap().unwrap();
    assert_eq!(stored, old);
    assert!(cursor.seq > event_seq, "the cursor moved past the event");
    assert_eq!(
        c.resume_cursor(record.id, Tier::M1, h.db_instance_uuid, old)
            .unwrap(),
        Some(cursor),
        "the same build resumes where it stopped"
    );

    // --- The upgraded controller -------------------------------------------------------
    let run = sync(&mut a, &controller, &h, Tier::M1, 1000);
    assert_eq!(run.requests[0].after, None, "kinds widened: from the start");
    assert_eq!(run.pages.iter().map(|p| p.events.len()).sum::<usize>(), 1);
    assert_eq!(count(&ctl_db, "SELECT count(*) FROM events"), 1);
    assert_eq!(count(&ctl_db, "SELECT count(*) FROM gaps"), 1);
    assert_eq!(
        c.cursor(record.id, Tier::M1).unwrap().unwrap().1,
        SyncKinds::ALL
    );
    let q = all_series(record.id, T0 - HOUR, T0 + HOUR, Tier::M1);
    assert_eq!(history(&controller, &q), history(&agent, &q));
}

/// D-076: the agent rolls minutes older than 7 days into 15-minute rows. A controller that
/// negotiated `rows.m15` keeps its minute cursor (the roll-down is not a truncation for
/// it) and pulls the 15-minute rows on their own cursor. A controller without it, whose
/// minute cursor missed rows that were rolled down, is told the cursor was truncated at the
/// roll cut and records the gap honestly; it gets nothing from the 15-minute tier. (A
/// fresh cursor reads whatever minutes exist, as after an ordinary prune.)
#[test]
fn rolled_down_minutes_sync_as_their_own_kind() {
    let dir = temp_dir("sync-m15");
    let record = host(1);
    let agent = open(&dir, "agent.sqlite");
    let new_ctl = open(&dir, "new.sqlite");
    let old_ctl = open(&dir, "old.sqlite");
    let aw = agent.writer();
    aw.upsert_host(record.clone()).unwrap();
    let h = hello(&agent, &record);
    for c in [&new_ctl, &old_ctl] {
        c.writer()
            .upsert_host(HostRecord::from_identity(h.host.clone(), false))
            .unwrap();
    }
    let old_offer = Offer::local(BTreeSet::from([
        "rows.buckets".to_string(),
        "rows.events".to_string(),
        "rows.gaps".to_string(),
    ]));
    let old = negotiate(&old_offer, &Offer::from(&h))
        .unwrap()
        .sync_kinds();
    assert!(!old.contains(SyncRowKind::M15));

    // Both controllers sync the first hour; then the agent writes a second hour that
    // neither syncs before it is rolled down, and the last hour a week later.
    fill(&agent, &record, T0, 60);
    let mut a = agent.reader().unwrap();
    sync(&mut a, &new_ctl, &h, Tier::M1, 50);
    sync_kinds(&mut a, &old_ctl, &h, Tier::M1, 50, old);
    fill(&agent, &record, T0 + HOUR, 60);
    let now = T0 + 8 * DAY;
    fill(&agent, &record, now - HOUR, 60);
    let report = aw.prune(now, Retention::default()).unwrap();
    assert_eq!(report.m1_rolled, 2 * 60);
    assert_eq!(
        report.m15_written,
        2 * 4,
        "layout switches fall on quarter boundaries"
    );
    let roll_cut = now - 7 * DAY;

    // --- Current controller ------------------------------------------------------------
    let mut a = agent.reader().unwrap();
    let run = sync(&mut a, &new_ctl, &h, Tier::M1, 50);
    assert!(
        run.truncations.is_empty(),
        "roll-down is not a truncation here"
    );
    let run = sync(&mut a, &new_ctl, &h, Tier::M15, 5);
    assert!(run.truncations.is_empty());
    assert_eq!(
        run.pages.iter().map(|p| p.rows.len()).sum::<usize>(),
        report.m15_written as usize
    );
    // Once the controller rolls its own copy down too, the two agree.
    new_ctl.writer().prune(now, Retention::default()).unwrap();
    let q = all_series(record.id, T0, now, Tier::M15);
    let agent_view = history(&agent, &q);
    assert!(!agent_view.series.is_empty());
    assert_eq!(history(&new_ctl, &q), agent_view);
    assert_eq!(
        count(&raw(&new_ctl), "SELECT count(*) FROM gaps"),
        0,
        "no gap made up"
    );

    // --- Controller without rows.m15 ---------------------------------------------------
    let run = sync_kinds(&mut a, &old_ctl, &h, Tier::M1, 50, old);
    assert_eq!(run.truncations.len(), 1, "{:?}", run.truncations);
    let (earliest, gap) = &run.truncations[0];
    assert_eq!(*earliest, roll_cut);
    assert!(gap.is_some(), "an honest truncated gap over what it missed");
    // It still gets the minutes the agent kept.
    let q = all_series(record.id, now - HOUR, now, Tier::M1);
    assert_eq!(history(&old_ctl, &q), history(&agent, &q));
    // And nothing from the 15-minute tier it did not negotiate.
    let run = sync_kinds(&mut a, &old_ctl, &h, Tier::M15, 50, old);
    assert!(run.pages.iter().all(|p| p.rows.is_empty()));
    assert_eq!(count(&raw(&old_ctl), "SELECT count(*) FROM tier_15m"), 0);
}

#[test]
fn stable_source_rows_update_and_replay_durably() {
    let dir = temp_dir("stable-source");
    let mirror = open(&dir, "mirror.sqlite");
    let h = host(2);
    let w = mirror.writer();
    w.upsert_host(h.clone()).unwrap();
    let mut page = CursorPage {
        tier: Tier::M1,
        epoch: Uuid::new_v4(),
        kinds: SyncKinds::ALL,
        layouts: vec![],
        rows: vec![],
        gaps: vec![PageGap {
            source_id: Some(7),
            seq: 1,
            gap: Gap::host(T0, None, GapReason::Paused).unwrap(),
        }],
        events: vec![PageEvent {
            source_id: Some(9),
            seq: 2,
            ts_ms: T0,
            kind: "annotation".into(),
            payload: vec![1],
        }],
        last_seq: 2,
        more: false,
    };
    w.ingest_page_durable(h.id, page.clone()).unwrap();
    // A separate reader observes committed rows and cursor without an explicit flush.
    assert_eq!(
        mirror
            .reader()
            .unwrap()
            .cursor(h.id, Tier::M1)
            .unwrap()
            .unwrap()
            .0
            .seq,
        2
    );
    let old = page.clone();
    page.gaps[0].gap.end_ms = Some(T0 + MIN);
    page.gaps[0].seq = 3;
    page.events[0].payload = vec![2];
    page.events[0].seq = 4;
    page.last_seq = 4;
    w.ingest_page_durable(h.id, page.clone()).unwrap();
    w.ingest_page_durable(h.id, old).unwrap();
    let conn = raw(&mirror);
    let gap: (i64, Option<i64>) = conn
        .query_row("SELECT count(*), max(end_ts) FROM gaps", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(gap, (1, Some(T0 + MIN)));
    let events: (i64, Vec<u8>) = conn
        .query_row("SELECT count(*), payload FROM events", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(events, (1, vec![2]));
    assert_eq!(
        mirror
            .reader()
            .unwrap()
            .cursor(h.id, Tier::M1)
            .unwrap()
            .unwrap()
            .0
            .seq,
        4
    );
    // Same source row IDs in a new epoch are new rows, preserving old history.
    page.epoch = Uuid::new_v4();
    w.ingest_page_durable(h.id, page).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM gaps", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2,
        "new source epoch preserves the old gap even if its natural key matches"
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn sync_reports_new_alerts_in_page_order_and_skips_replays_and_updates() {
    let dir = temp_dir("inserted-alerts");
    let mirror = open(&dir, "mirror.sqlite");
    let h = host(2);
    let w = mirror.writer();
    w.upsert_host(h.clone()).unwrap();

    let first = alert(T0 + MIN, "High CPU", 90.0);
    let second = alert(T0, "Sustained CPU", 95.0);
    let fan = Event {
        ts_ms: T0 + 1,
        start_ms: T0,
        processes: vec![],
        detail: EventDetail::FansRamped {
            from_rpm: 1200.0,
            to_rpm: 3000.0,
        },
    };
    let mut page = event_page(vec![
        page_event(&first, Some(1), 1),
        page_event(&fan, Some(2), 2),
        page_event(&second, Some(3), 3),
    ]);
    let first_report = w.ingest_page_durable(h.id, page.clone()).unwrap();
    assert_eq!(
        first_report,
        IngestReport {
            events_written: 3,
            alerts_inserted: vec![first.clone(), second.clone()],
            ..IngestReport::default()
        }
    );

    let replay = w.ingest_page_durable(h.id, page.clone()).unwrap();
    assert_eq!(replay, IngestReport::default());

    let amended = alert(first.ts_ms, "High CPU", 99.0);
    page.events = vec![page_event(&amended, Some(1), 4)];
    page.last_seq = 4;
    let update = w.ingest_page_durable(h.id, page).unwrap();
    assert_eq!(
        update,
        IngestReport {
            events_written: 1,
            ..IngestReport::default()
        }
    );
    assert_eq!(
        mirror
            .reader()
            .unwrap()
            .events(h.id, T0, T0 + HOUR)
            .unwrap(),
        [second, fan, amended],
    );
}

#[test]
fn sync_reports_a_legacy_alert_only_when_its_dedupe_key_is_new() {
    let dir = temp_dir("legacy-alert");
    let mirror = open(&dir, "mirror.sqlite");
    let h = host(2);
    let w = mirror.writer();
    w.upsert_host(h.clone()).unwrap();

    let first = alert(T0, "High CPU", 90.0);
    let mut page = event_page(vec![page_event(&first, None, 1)]);
    let insert = w.ingest_page_durable(h.id, page.clone()).unwrap();
    assert_eq!(
        insert,
        IngestReport {
            events_written: 1,
            alerts_inserted: vec![first],
            ..IngestReport::default()
        }
    );

    let replay = w.ingest_page_durable(h.id, page.clone()).unwrap();
    assert_eq!(replay, IngestReport::default());

    let amended = alert(T0, "High CPU", 99.0);
    page.events = vec![page_event(&amended, None, 2)];
    page.last_seq = 2;
    let update = w.ingest_page_durable(h.id, page).unwrap();
    assert_eq!(
        update,
        IngestReport {
            events_written: 1,
            ..IngestReport::default()
        }
    );
    assert_eq!(
        mirror
            .reader()
            .unwrap()
            .events(h.id, T0, T0 + HOUR)
            .unwrap(),
        [amended],
    );
}

#[test]
fn sync_warns_for_unreadable_alerts_without_decoding_non_alerts() {
    let (sender, logs) = mpsc::channel();
    // The store spawns its own writer thread, which uses the global subscriber.
    tracing::subscriber::set_global_default(SyncLogs(sender)).unwrap();
    let dir = temp_dir("unreadable-alerts");
    let mirror = open(&dir, "mirror.sqlite");
    let h = host(2);
    let w = mirror.writer();
    w.upsert_host(h.clone()).unwrap();

    let event = alert(T0, "High CPU", 90.0);
    let mut unreadable_alert = page_event(&event, Some(42), 1);
    unreadable_alert.payload = vec![0xff];
    let mut other = unreadable_alert.clone();
    other.source_id = Some(43);
    other.seq = 2;
    other.ts_ms = T0 + 1;
    other.kind = "fans_ramped".into();
    let mut mismatched = page_event(&event, Some(44), 3);
    mismatched.kind = other.kind.clone();
    let page = event_page(vec![unreadable_alert, other, mismatched]);

    assert_eq!(
        w.ingest_page_durable(h.id, page.clone()).unwrap(),
        IngestReport {
            events_written: 3,
            ..IngestReport::default()
        }
    );
    assert_eq!(
        w.ingest_page_durable(h.id, page).unwrap(),
        IngestReport::default()
    );
    let persisted = mirror
        .reader()
        .unwrap()
        .events_counted(h.id, T0, T0 + HOUR)
        .unwrap();
    assert_eq!(persisted.unreadable, 2);
    assert_eq!(persisted.events, [event]);
    assert_eq!(
        logs.try_iter().collect::<Vec<_>>(),
        [(
            Level::WARN,
            AlertLog {
                source_id: Some("Some(42)".into()),
                ts_ms: Some(T0),
                message: Some("cannot decode a newly inserted remote alert".into()),
            }
        )]
    );
}

struct SyncLogs(mpsc::Sender<(Level, AlertLog)>);

impl Subscriber for SyncLogs {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.is_event() && metadata.target() == "statglass_store::writer::sync"
    }

    fn event(&self, event: &tracing::Event<'_>) {
        let mut log = AlertLog::default();
        event.record(&mut log);
        let _ = self.0.send((*event.metadata().level(), log));
    }

    fn new_span(&self, _: &span::Attributes<'_>) -> span::Id {
        span::Id::from_u64(1)
    }
    fn record(&self, _: &span::Id, _: &span::Record<'_>) {}
    fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}
    fn enter(&self, _: &span::Id) {}
    fn exit(&self, _: &span::Id) {}
}

#[derive(Debug, Default, PartialEq)]
struct AlertLog {
    source_id: Option<String>,
    ts_ms: Option<i64>,
    message: Option<String>,
}

impl field::Visit for AlertLog {
    fn record_i64(&mut self, field: &field::Field, value: i64) {
        if field.name() == "ts_ms" {
            self.ts_ms = Some(value);
        }
    }

    fn record_debug(&mut self, field: &field::Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "source_id" => self.source_id = Some(format!("{value:?}")),
            "message" => self.message = Some(format!("{value:?}")),
            _ => {}
        }
    }
}

#[test]
fn sync_rolls_back_alerts_and_cursor_when_usage_flush_fails() {
    let dir = temp_dir("failed-usage-flush");
    let mirror = open(&dir, "mirror.sqlite");
    let h = host(2);
    let w = mirror.writer();
    w.upsert_host(h.clone()).unwrap();
    w.flush().unwrap();
    let event = alert(T0, "High CPU", 90.0);
    let page = event_page(vec![page_event(&event, Some(1), 1)]);

    let conn = rusqlite::Connection::open(mirror.path()).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER reject_usage_coverage BEFORE INSERT ON usage_coverage BEGIN
            SELECT RAISE(FAIL, 'usage coverage write failed');
         END;",
    )
    .unwrap();
    let ticket = w
        .write_usage_bucket(
            h.id,
            UsageBucket {
                from_ms: T0,
                to_ms: T0 + 10_000,
                source: [UsageSourceCoverage::default(); 5],
                apps: vec![],
                processes: vec![],
                uncertain_network: vec![],
            },
        )
        .unwrap();
    let error = w.ingest_page_durable(h.id, page.clone()).unwrap_err();
    assert!(matches!(
        error,
        StoreError::Sqlite(rusqlite::Error::SqliteFailure(..))
    ));
    assert_eq!(error.to_string(), "sqlite: usage coverage write failed");
    let commits = w.usage_commits();
    assert_eq!(commits.committed, 0);
    assert_eq!(commits.failed_through, ticket);

    conn.execute_batch("DROP TRIGGER reject_usage_coverage")
        .unwrap();
    w.flush().unwrap();
    let mut reader = mirror.reader().unwrap();
    assert!(reader.events(h.id, T0, T0 + HOUR).unwrap().is_empty());
    assert!(reader.cursor(h.id, Tier::M1).unwrap().is_none());
    assert_eq!(
        w.ingest_page_durable(h.id, page).unwrap(),
        IngestReport {
            events_written: 1,
            alerts_inserted: vec![event.clone()],
            ..IngestReport::default()
        }
    );
    assert_eq!(reader.events(h.id, T0, T0 + HOUR).unwrap(), [event]);
}

#[test]
fn sync_rolls_back_alerts_and_cursor_when_commit_accounting_fails() {
    let dir = temp_dir("failed-commit-accounting");
    let mirror = open(&dir, "mirror.sqlite");
    let h = host(2);
    let w = mirror.writer();
    w.upsert_host(h.clone()).unwrap();
    w.flush().unwrap();
    let event = alert(T0, "High CPU", 90.0);
    let page = event_page(vec![page_event(&event, Some(1), 1)]);

    let conn = rusqlite::Connection::open(mirror.path()).unwrap();
    let next_seq: i64 = conn
        .query_row("SELECT value FROM meta WHERE key = 'next_seq'", [], |r| {
            r.get(0)
        })
        .unwrap();
    // The Docker batch stages normally. Inserting the event breaks the following
    // accounting read by overflowing the sum of the entity and metadata entries.
    conn.execute_batch(
        "CREATE TRIGGER break_docker_accounting AFTER INSERT ON events BEGIN
            UPDATE docker_accounting SET logical_bytes = 9223372036854775807;
         END;",
    )
    .unwrap();
    let receipt = w
        .write_docker(DockerBatch {
            host: h.id,
            daemon_id: "daemon".into(),
            generation: 1,
            revision: 1,
            start_ms: T0,
            end_ms: T0 + 10_000,
            runtime: "OrbStack".into(),
            entities: vec![DockerEntity {
                external_id: "c".into(),
                name: "Container".into(),
                effective_ms: T0,
                last_seen_ms: T0,
                revision: 1,
                ..Default::default()
            }],
            buckets: vec![],
            events: vec![],
            coverage: vec![],
            cursor: None,
            populations: vec![],
        })
        .unwrap();
    let error = w.ingest_page_durable(h.id, page.clone()).unwrap_err();
    let StoreError::Sqlite(rusqlite::Error::SqliteFailure(code, message)) = error else {
        panic!("expected the accounting query to fail, got {error:?}");
    };
    assert_eq!(code.extended_code, rusqlite::ffi::SQLITE_ERROR);
    assert_eq!(message.as_deref(), Some("integer overflow"));
    let ack = receipt.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        (
            ack.generation,
            ack.revision,
            ack.outcome,
            ack.reason.as_deref()
        ),
        (
            1,
            1,
            DockerOutcome::Failed,
            Some("sqlite: integer overflow")
        )
    );
    assert_eq!(count(&conn, "SELECT count(*) FROM docker_accounting"), 0);

    let mut reader = mirror.reader().unwrap();
    assert!(reader.events(h.id, T0, T0 + HOUR).unwrap().is_empty());
    assert!(reader.cursor(h.id, Tier::M1).unwrap().is_none());

    conn.execute_batch("DROP TRIGGER break_docker_accounting")
        .unwrap();
    let retry = w.ingest_page_durable(h.id, page).unwrap();
    assert_eq!(
        retry,
        IngestReport {
            events_written: 1,
            alerts_inserted: vec![event.clone()],
            ..IngestReport::default()
        }
    );
    assert_eq!(reader.events(h.id, T0, T0 + HOUR).unwrap(), [event]);
    let identity: (i64, i64) = conn
        .query_row("SELECT seq, export_id FROM events", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(identity, (next_seq, next_seq));
}

fn alert(ts_ms: i64, rule_name: &str, value: f32) -> Event {
    Event {
        ts_ms,
        start_ms: ts_ms - MIN,
        processes: vec![],
        detail: EventDetail::Alert {
            rule_id: Uuid::from_u128(1),
            rule_name: rule_name.into(),
            cause: AlertCause::Threshold {
                metric: key("cpu.total").metric,
                labels: Labels::default(),
                value,
                op: Cmp::Gt,
                threshold: 80.0,
                for_secs: 60,
            },
        },
    }
}

fn page_event(event: &Event, source_id: Option<i64>, seq: i64) -> PageEvent {
    let mut payload = Vec::new();
    ciborium::into_writer(event, &mut payload).unwrap();
    PageEvent {
        source_id,
        seq,
        ts_ms: event.ts_ms,
        kind: event.detail.kind().into(),
        payload,
    }
}

fn event_page(events: Vec<PageEvent>) -> CursorPage {
    CursorPage {
        tier: Tier::M1,
        epoch: Uuid::new_v4(),
        kinds: SyncKinds::ALL,
        layouts: vec![],
        rows: vec![],
        gaps: vec![],
        last_seq: events.last().unwrap().seq,
        events,
        more: false,
    }
}

#[test]
fn mirror_pruning_does_not_synthesize_incomplete_coarse_buckets() {
    let dir = temp_dir("mirror-prune");
    let mirror = open(&dir, "mirror.sqlite");
    let h = host(2);
    let w = mirror.writer();
    w.upsert_host(h.clone()).unwrap();
    w.write_bucket(bucket(h.id, Tier::M1, T0, &layout(&["cpu.total"]), 3.0))
        .unwrap();
    let report = w.prune_mirror(T0 + 8 * DAY, Retention::default()).unwrap();
    assert_eq!(report.m15_written, 0);
    assert_eq!(report.m1_rows, 1);
    assert_eq!(
        raw(&mirror)
            .query_row("SELECT count(*) FROM tier_15m", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn bounded_export_keeps_open_gaps_and_filters_old_buckets() {
    let dir = temp_dir("bounded-export");
    let store = open(&dir, "source.sqlite");
    let h = host(1);
    let w = store.writer();
    w.upsert_host(h.clone()).unwrap();
    for ts in [T0, T0 + MIN] {
        w.write_bucket(bucket(h.id, Tier::M1, ts, &layout(&["cpu.total"]), 3.0))
            .unwrap();
    }
    w.flush().unwrap();
    let CursorRead::Page(page) = store
        .reader()
        .unwrap()
        .read_after_since(h.id, Tier::M1, None, 2000, SyncKinds::ALL, Some(T0 + MIN))
        .unwrap()
    else {
        panic!("page expected")
    };
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].bucket_ts, T0 + MIN);
}

#[test]
fn rejected_page_commits_neither_rows_nor_cursor() {
    let dir = temp_dir("atomic-page");
    let mirror = open(&dir, "mirror.sqlite");
    let h = host(2);
    let w = mirror.writer();
    w.upsert_host(h.clone()).unwrap();
    w.flush().unwrap();
    let page = CursorPage {
        tier: Tier::M1,
        epoch: Uuid::new_v4(),
        kinds: SyncKinds::ALL,
        layouts: vec![],
        rows: vec![],
        gaps: vec![PageGap {
            source_id: Some(1),
            seq: 1,
            gap: Gap::host(T0, Some(T0 + MIN), GapReason::Paused).unwrap(),
        }],
        events: vec![PageEvent {
            source_id: Some(-1),
            seq: 2,
            ts_ms: T0,
            kind: "annotation".into(),
            payload: vec![],
        }],
        last_seq: 2,
        more: false,
    };
    assert!(w.ingest_page_durable(h.id, page).is_err());
    w.flush().unwrap();
    assert!(
        mirror
            .reader()
            .unwrap()
            .cursor(h.id, Tier::M1)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        raw(&mirror)
            .query_row("SELECT count(*) FROM gaps", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn exported_identity_survives_update_and_is_not_reused_after_pruning() {
    let dir = temp_dir("export-identity");
    let store = open(&dir, "source.sqlite");
    let h = host(1);
    let w = store.writer();
    w.upsert_host(h.clone()).unwrap();
    w.open_gap(h.id, T0, None, GapReason::Paused).unwrap();
    w.flush().unwrap();
    let read = || {
        let CursorRead::Page(p) = store
            .reader()
            .unwrap()
            .read_after(h.id, Tier::M1, None, 2000, SyncKinds::ALL)
            .unwrap()
        else {
            panic!("page")
        };
        p
    };
    let first = read().gaps[0].clone();
    w.close_gap(h.id, GapReason::Paused, None, Some(T0), T0 + MIN)
        .unwrap();
    w.flush().unwrap();
    let closed = read().gaps[0].clone();
    assert_eq!(first.source_id, closed.source_id);
    assert!(closed.seq > first.seq);
    w.prune(T0 + 40 * DAY, Retention::default()).unwrap();
    w.open_gap(h.id, T0 + 41 * DAY, None, GapReason::Paused)
        .unwrap();
    w.flush().unwrap();
    assert_ne!(read().gaps[0].source_id, first.source_id);
}

#[test]
fn mirror_budget_can_trim_recent_data_without_changing_local_retention() {
    let dir = temp_dir("mirror-budget");
    let store = open(&dir, "mirror.sqlite");
    let h = host(2);
    let w = store.writer();
    w.upsert_host(h.clone()).unwrap();
    w.flush().unwrap();
    let mut retention = Retention::mirror_default();
    // A prune checkpoints the WAL, so the budget measures the file and not however
    // many duplicate frames the migrations left in the WAL.
    w.prune_mirror(T0, retention).unwrap();
    // Fixed SQLite tables cannot be shrunk, but the imported payload can be.
    retention.max_bytes = statglass_store::size_on_disk(store.path()).unwrap() + 32_768;
    let page = CursorPage {
        tier: Tier::M1,
        epoch: Uuid::new_v4(),
        kinds: SyncKinds::ALL,
        layouts: vec![],
        rows: vec![],
        gaps: vec![],
        events: vec![PageEvent {
            source_id: Some(1),
            seq: 1,
            ts_ms: T0,
            kind: "annotation".into(),
            payload: vec![42; 512 * 1024],
        }],
        last_seq: 1,
        more: false,
    };
    w.ingest_page_durable(h.id, page).unwrap();
    let report = w.prune_mirror(T0 + MIN, retention).unwrap();
    assert_eq!(report.cap_trim.unwrap().events, 1);
    assert_eq!(
        raw(&store)
            .query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
