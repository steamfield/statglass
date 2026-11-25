//! What a mirror keeps and syncs: which tiers, how far back, its retention and how an
//! Auto history query resolves against it. The desktop keeps every tier; a phone keeps
//! minutes for a day and quarter hours for a month (RFC `plan/rfc-ios-app.md` §4.4).
use statglass_schema::Tier;
use statglass_store::{Retention, TierChoice, TierCoverage};

/// A phone's mirror budget per host, MB.
pub const PHONE_MIRROR_HOST_MB: u32 = 25;
/// A phone's mirror budget across every host, MB. The caller enforces it.
pub const PHONE_MIRROR_TOTAL_MB: u32 = 250;

/// The desktop's sync tiers, finest first.
const DESKTOP_TIERS: [Tier; 3] = [Tier::S10, Tier::M1, Tier::M15];
const PHONE_TIERS: [Tier; 2] = [Tier::M1, Tier::M15];
const PHONE_M1_MS: i64 = Retention::DAY_MS;
const M15_MS: i64 = 30 * Retention::DAY_MS;

/// What a mirror keeps and syncs: tiers, floors, retention and the Auto history choice.
#[derive(Clone, Debug, PartialEq)]
pub struct MirrorPolicy {
    budget_mb: u32,
    phone: bool,
}

impl MirrorPolicy {
    /// Today's desktop mirror under a `budget_mb` cap.
    pub fn desktop(budget_mb: u32) -> Self {
        Self {
            budget_mb,
            phone: false,
        }
    }

    /// A phone's mirror under a `budget_mb` cap.
    pub fn phone(budget_mb: u32) -> Self {
        Self {
            budget_mb,
            phone: true,
        }
    }

    /// The storage cap, MB.
    pub fn budget_mb(&self) -> u32 {
        self.budget_mb
    }

    /// The tiers a session syncs, finest first.
    pub fn sync_tiers(&self) -> &[Tier] {
        if self.phone {
            &PHONE_TIERS
        } else {
            &DESKTOP_TIERS
        }
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
        let mut retention = Retention {
            max_bytes: u64::from(self.budget_mb) * 1_000_000,
            ..Retention::mirror_default()
        };
        if self.phone {
            retention.s10_ms = 0;
            retention.m1_ms = PHONE_M1_MS;
            retention.history_ms = M15_MS;
        }
        retention
    }

    /// The tier choice an Auto history query uses against this mirror.
    pub fn auto_choice(&self) -> TierChoice {
        if self.phone {
            TierChoice::Covered(TierCoverage {
                s10_ms: None,
                m1_ms: Some(PHONE_M1_MS),
            })
        } else {
            TierChoice::Auto
        }
    }

    /// Whether recent rows are asked for before the first sync page.
    pub fn recent_first(&self) -> bool {
        self.phone
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
        assert!(!policy.recent_first());
    }

    #[test]
    fn phone_policy_sets_the_budget_retention_and_covered_choice() {
        assert_eq!(PHONE_MIRROR_HOST_MB, 25);
        assert_eq!(PHONE_MIRROR_TOTAL_MB, 250);
        let policy = MirrorPolicy::phone(PHONE_MIRROR_HOST_MB);
        assert_eq!(
            policy.retention(),
            Retention {
                s10_ms: 0,
                m1_ms: 86_400_000,
                history_ms: 2_592_000_000,
                max_bytes: 25_000_000,
                ..Retention::mirror_default()
            }
        );
        assert_eq!(
            policy.auto_choice(),
            TierChoice::Covered(TierCoverage {
                s10_ms: None,
                m1_ms: Some(86_400_000),
            })
        );
    }
}
