//! A host's recent-history snapshot (`RecentRows`) as store bucket rows. The mirror keeps
//! them beside its durable rows; a session without a mirror refills its live ring from
//! them directly.
use crate::MirrorError;
use statglass_proto::{WireBucket, WireLayout};
use statglass_schema::{Catalog, HostId, Tier};
use statglass_store::BucketRow;

/// The most rows or layouts one snapshot may carry.
const MAX_SNAPSHOT_ITEMS: usize = 2000;

/// Checked snapshot rows, and how many series the cardinality caps dropped.
pub(crate) struct RecentBuckets {
    pub rows: Vec<BucketRow>,
    pub capped: usize,
}

/// Validates a snapshot and converts its rows. Only S10 snapshots are accepted: they are
/// what the live ring refills from. Every row must name a known layout, carry three stats
/// per series, sit on the 10 s grid and fall within `RECENT_ROWS_MS` before
/// `complete_to_ms` (the open bucket beginning at `complete_to_ms` included).
pub(crate) fn recent_buckets(
    catalog: &Catalog,
    host: HostId,
    tier: Tier,
    complete_to_ms: i64,
    mut layouts: Vec<WireLayout>,
    mut rows: Vec<WireBucket>,
) -> Result<RecentBuckets, MirrorError> {
    if tier != Tier::S10 {
        return Err(MirrorError::InvalidInput(
            "Unsupported or oversized recent-history snapshot",
        ));
    }
    if rows.len() > MAX_SNAPSHOT_ITEMS || layouts.len() > MAX_SNAPSHOT_ITEMS {
        return Err(MirrorError::ResourceLimit(
            "Unsupported or oversized recent-history snapshot",
        ));
    }
    let width = tier
        .bucket_ms()
        .ok_or(MirrorError::InvalidInput("Invalid recent tier"))?;
    let capped = crate::pages::cap_layouts(catalog, &mut layouts, &mut rows);
    let floor = complete_to_ms.saturating_sub(statglass_engine::RECENT_ROWS_MS);
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let layout = layouts
            .iter()
            .find(|l| l.layout_no == row.layout_no)
            .ok_or(MirrorError::InvalidInput("Unknown recent layout"))?;
        if row.stats.len() != layout.series.len().saturating_mul(3)
            || row.bucket_ts < floor
            || row.bucket_ts > complete_to_ms
            || row.bucket_ts.rem_euclid(width) != 0
        {
            return Err(MirrorError::InvalidInput("Invalid recent row"));
        }
        out.push(BucketRow {
            host,
            tier,
            bucket_ts: row.bucket_ts,
            series: layout.series.clone().into(),
            stats: row.stats,
        });
    }
    Ok(RecentBuckets { rows: out, capped })
}
