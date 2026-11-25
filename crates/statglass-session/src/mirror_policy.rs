//! What a mirror keeps and syncs: which tiers, how far back, its retention and how an
//! Auto history query resolves against it. The desktop keeps every tier; a phone keeps
//! minutes for a day and quarter hours for a month (RFC `plan/rfc-ios-app.md` 5).
//!
//! Scaffold: `desktop` reproduces today's numbers, and `phone` returns them too until
//! phase 3 lane b implements the phone policy.
use statglass_schema::Tier;
use statglass_store::{Retention, TierChoice};

/// A phone's mirror budget per host, MB (RFC 5).
pub const PHONE_MIRROR_HOST_MB: u32 = 25;
/// A phone's mirror budget across every host, MB (RFC 5). The phase 4 caller enforces it.
pub const PHONE_MIRROR_TOTAL_MB: u32 = 250;

/// The desktop's sync tiers, finest first.
const DESKTOP_TIERS: [Tier; 3] = [Tier::S10, Tier::M1, Tier::M15];

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

    /// A phone's mirror under a `budget_mb` cap. Scaffold stub: the desktop policy until
    /// phase 3 lane b.
    pub fn phone(budget_mb: u32) -> Self {
        Self::desktop(budget_mb)
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
        now_ms.saturating_sub(match tier {
            Tier::S10 => Retention::DAY_MS,
            Tier::M1 => Retention::M1_WINDOW_MS,
            _ => 30 * Retention::DAY_MS,
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

    /// Whether recent rows are asked for before the first sync page.
    pub fn recent_first(&self) -> bool {
        false
    }
}
