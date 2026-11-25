//! What a mirror keeps and syncs: which tiers, how far back, its retention and how an
//! Auto history query resolves against it.
use statglass_schema::Tier;
use statglass_store::{Retention, TierChoice};

/// The desktop's sync tiers, finest first.
const DESKTOP_TIERS: [Tier; 3] = [Tier::S10, Tier::M1, Tier::M15];
const M15_MS: i64 = 30 * Retention::DAY_MS;

/// What a mirror keeps and syncs: tiers, floors, retention and the Auto history choice.
#[derive(Clone, Debug, PartialEq)]
pub struct MirrorPolicy {
    budget_mb: u32,
}

impl MirrorPolicy {
    /// Today's desktop mirror under a `budget_mb` cap.
    pub fn desktop(budget_mb: u32) -> Self {
        Self { budget_mb }
    }

    /// The storage cap, MB.
    pub fn budget_mb(&self) -> u32 {
        self.budget_mb
    }

    /// The tiers a session syncs, finest first.
    pub fn sync_tiers(&self) -> &[Tier] {
        &DESKTOP_TIERS
    }

    /// The oldest timestamp worth syncing for `tier` at `now_ms`.
    pub fn floor(&self, tier: Tier, now_ms: i64) -> i64 {
        let retention = self.retention();
        now_ms.saturating_sub(match tier {
            Tier::S10 => retention.s10_ms,
            Tier::M1 => retention.m1_ms,
            _ => M15_MS,
        })
    }

    /// How the mirror's store prunes, capped at the budget.
    pub fn retention(&self) -> Retention {
        Retention {
            max_bytes: u64::from(self.budget_mb) * 1_000_000,
            ..Retention::mirror_default()
        }
    }

    /// The tier choice an Auto history query uses against this mirror.
    pub fn auto_choice(&self) -> TierChoice {
        TierChoice::Auto
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_policy_keeps_the_existing_defaults() {
        let policy = MirrorPolicy::desktop(37);
        assert_eq!(policy.budget_mb(), 37);
        assert_eq!(policy.sync_tiers(), &[Tier::S10, Tier::M1, Tier::M15]);
        for (tier, keep) in [
            (Tier::S10, 86_400_000),
            (Tier::M1, 604_800_000),
            (Tier::M15, 2_592_000_000),
        ] {
            assert_eq!(policy.floor(tier, 0), -keep);
        }
        assert_eq!(
            policy.retention(),
            Retention {
                max_bytes: 37_000_000,
                ..Retention::mirror_default()
            }
        );
        assert_eq!(policy.auto_choice(), TierChoice::Auto);
    }
}
