use crate::TierCoverage;
use statglass_schema::Tier;

pub fn tier_for_budget(
    _from_ms: i64,
    _to_ms: i64,
    _max_points: u32,
    _retained: TierCoverage,
) -> Tier {
    Tier::S10
}
