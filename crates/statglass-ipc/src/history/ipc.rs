//! Translation between the history request, store queries and their pages.
use super::*;
use statglass_schema::TimeRange;
use statglass_store::{HistoryQuery, HistoryResult};

impl HistoryRequest {
    pub fn to_query(&self) -> Result<HistoryQuery, CommandError> {
        self.to_query_with(TierChoice::Auto)
    }

    /// The store query with the caller's policy for `Auto`.
    pub fn to_query_with(&self, auto: TierChoice) -> Result<HistoryQuery, CommandError> {
        TimeRange::new(self.from_ms, self.to_ms, i64::MAX)?;
        if self.max_points == 0 {
            return Err(CommandError::InvalidArgument {
                message: "max_points must be at least 1".into(),
            });
        }
        Ok(HistoryQuery {
            host: self.host,
            selectors: self.selectors.clone(),
            from_ms: self.from_ms,
            to_ms: self.to_ms,
            tier: self.tier.choice(auto),
            max_points: self.max_points,
        })
    }
}

impl TierRequest {
    /// Resolves the requested tier, using `auto` for the implicit selection.
    pub fn choice(self, auto: TierChoice) -> TierChoice {
        match self {
            Self::Auto => auto,
            Self::S10 => TierChoice::Fixed(Tier::S10),
            Self::M1 => TierChoice::Fixed(Tier::M1),
            Self::M15 => TierChoice::Fixed(Tier::M15),
        }
    }
}

/// The IPC page of `r`, each series with `hold(key, bucket_ms)` as its `hold_ms`.
pub(super) fn history_page(r: HistoryResult, hold: impl Fn(&SeriesKey, i64) -> i64) -> HistoryPage {
    HistoryPage {
        tier: r.tier,
        bucket_ms: r.bucket_ms,
        series: r
            .series
            .into_iter()
            .map(|s| HistorySeries {
                hold_ms: hold(&s.key, r.bucket_ms),
                key: s.key,
                points: s
                    .points
                    .into_iter()
                    .map(|p| HistoryPoint {
                        t: p.t,
                        min: p.min,
                        max: p.max,
                        avg: p.avg,
                    })
                    .collect(),
            })
            .collect(),
        gaps: r.gaps,
    }
}
