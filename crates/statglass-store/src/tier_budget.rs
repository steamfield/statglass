use crate::TierCoverage;
use statglass_schema::Tier;

pub fn tier_for_budget(from_ms: i64, to_ms: i64, max_points: u32, retained: TierCoverage) -> Tier {
    let span = i128::from(to_ms) - i128::from(from_ms);
    let target_ms = span / i128::from(max_points.max(1));
    if target_ms >= 900_000 {
        return Tier::M15;
    }
    if target_ms < 60_000 && retained.s10_ms.is_some_and(|keep| span <= i128::from(keep)) {
        return Tier::S10;
    }
    if retained.m1_ms.is_some_and(|keep| span <= i128::from(keep)) {
        return Tier::M1;
    }
    Tier::M15
}
