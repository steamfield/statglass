//! Tier selection shared by history reads and CSV export.

use statglass_schema::{HostId, Tier};

use super::Reader;
use crate::db;
use crate::error::Result;
use crate::types::{HistoryQuery, Retention, TierChoice, TierCoverage};

impl Reader {
    /// The tier a [`TierChoice::Auto`] read of `host` over `[from_ms, to_ms)` uses, without
    /// reading it.
    pub fn auto_tier_for(&mut self, host: HostId, from_ms: i64, to_ms: i64) -> Result<Tier> {
        let host_ref = self.host_ref(host)?;
        self.auto_tier(host_ref, from_ms, to_ms)
    }

    pub(super) fn resolve_tier(
        &self,
        host_ref: i64,
        from_ms: i64,
        to_ms: i64,
        choice: TierChoice,
    ) -> Result<Tier> {
        match choice {
            TierChoice::Fixed(tier) => Ok(tier),
            TierChoice::Auto => self.auto_tier(host_ref, from_ms, to_ms),
            TierChoice::Covered(coverage) => {
                covered_tier(coverage, from_ms, to_ms, |tier| match tier {
                    Tier::S10 => self.s10_covers(host_ref, from_ms),
                    _ => self.retains_start(host_ref, tier, from_ms),
                })
            }
        }
    }

    /// `S10` when the range fits in the 10 s tier's window, pruning has not removed
    /// anything after its start, and low-disk mode left no holes in it (D-057).
    /// Otherwise `M15` when the range starts more than one 15-minute bucket before the
    /// minutes the roll-down has kept (D-076), and `M1` when it does not. The slack keeps
    /// a 7-day range ending now on minutes whether or not the last prune has rolled its
    /// first few minutes down.
    fn auto_tier(&self, host_ref: i64, from_ms: i64, to_ms: i64) -> Result<Tier> {
        if to_ms - from_ms <= Retention::default().s10_ms && self.s10_covers(host_ref, from_ms)? {
            return Ok(Tier::S10);
        }
        let quarter = Tier::M15.bucket_ms().unwrap_or(900_000);
        match self.pruned_key(host_ref, db::M1_ROLLED)? {
            Some((_, rolled_until)) if rolled_until.saturating_sub(from_ms) > quarter => {
                Ok(Tier::M15)
            }
            _ => Ok(Tier::M1),
        }
    }

    fn s10_covers(&self, host_ref: i64, from_ms: i64) -> Result<bool> {
        if db::read_s10_hole_until(&self.conn)?.is_some_and(|until| until > from_ms) {
            return Ok(false);
        }
        self.retains_start(host_ref, Tier::S10, from_ms)
    }

    /// A short range can still start before a tier's prune cutoff.
    fn retains_start(&self, host_ref: i64, tier: Tier, from_ms: i64) -> Result<bool> {
        Ok(!matches!(
            self.pruned(host_ref, tier)?,
            Some((_, cutoff)) if cutoff > from_ms
        ))
    }
}

pub(super) fn recent_tier(q: &HistoryQuery) -> Result<Tier> {
    match q.tier {
        TierChoice::Fixed(tier) => Ok(tier),
        TierChoice::Auto if q.to_ms - q.from_ms <= Retention::default().s10_ms => Ok(Tier::S10),
        TierChoice::Auto => Ok(Tier::M1),
        TierChoice::Covered(coverage) => covered_tier(coverage, q.from_ms, q.to_ms, |_| Ok(true)),
    }
}

fn covered_tier(
    coverage: TierCoverage,
    from_ms: i64,
    to_ms: i64,
    retains_range: impl Fn(Tier) -> Result<bool>,
) -> Result<Tier> {
    let span = i128::from(to_ms) - i128::from(from_ms);
    for (tier, keep) in [(Tier::S10, coverage.s10_ms), (Tier::M1, coverage.m1_ms)] {
        if keep.is_some_and(|keep| span <= i128::from(keep)) && retains_range(tier)? {
            return Ok(tier);
        }
    }
    Ok(Tier::M15)
}
