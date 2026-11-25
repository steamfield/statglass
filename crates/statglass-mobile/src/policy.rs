//! The phone's two policy rules: how much history a source syncs on the current path,
//! and each host's share of the mirror storage (phase 4 lane d).

use statglass_ipc::mobile::DataPolicy;
use statglass_session::{PHONE_MIRROR_HOST_MB, PHONE_MIRROR_TOTAL_MB, SyncPolicy};

use crate::ffi::NetworkPath;

/// The sync policy for `path` (`None`: not reported yet) under `data`.
/// With no usable path this returns the initial policy. Lifecycle keeps the last
/// applied policy when a reported path is unsatisfied.
pub(crate) fn sync_policy(path: Option<NetworkPath>, data: DataPolicy) -> SyncPolicy {
    let Some(path) = path.filter(|path| path.satisfied) else {
        return SyncPolicy::Full;
    };
    match (path.constrained, path.expensive, data.sync_on_cellular) {
        (true, _, _) | (false, true, false) => SyncPolicy::Off,
        (false, true, true) => SyncPolicy::SummaryOnly,
        (false, false, _) => SyncPolicy::Full,
    }
}

/// Each host's mirror budget when the phone has `hosts` hosts, so the total stays within
/// `PHONE_MIRROR_TOTAL_MB`.
pub(crate) fn host_budget_mb(hosts: usize) -> u32 {
    let Ok(hosts) = u32::try_from(hosts) else {
        return 0;
    };
    PHONE_MIRROR_TOTAL_MB
        .checked_div(hosts)
        .map_or(PHONE_MIRROR_HOST_MB, |share| {
            share.min(PHONE_MIRROR_HOST_MB)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_sync_depends_on_cost_constraint_and_cellular_setting() {
        use SyncPolicy::{Full, Off, SummaryOnly};

        for (path, expected) in [
            (None, [Full, Full]),
            (Some((true, false, false)), [Full, Full]),
            (Some((true, false, true)), [Off, Off]),
            (Some((true, true, false)), [Off, SummaryOnly]),
            (Some((true, true, true)), [Off, Off]),
            // A caller without a last policy gets the initial policy.
            (Some((false, false, false)), [Full, Full]),
            (Some((false, false, true)), [Full, Full]),
            (Some((false, true, false)), [Full, Full]),
            (Some((false, true, true)), [Full, Full]),
        ] {
            let path = path.map(|(satisfied, expensive, constrained)| NetworkPath {
                satisfied,
                expensive,
                constrained,
            });
            for (sync_on_cellular, expected) in [false, true].into_iter().zip(expected) {
                let data = DataPolicy { sync_on_cellular };
                assert_eq!(sync_policy(path, data), expected, "{path:?}, {data:?}");
            }
        }
    }

    #[test]
    fn per_host_budget_respects_both_caps() {
        for (hosts, budget) in [(0, 25), (1, 25), (10, 25), (11, 22), (250, 1), (251, 0)] {
            assert_eq!(host_budget_mb(hosts), budget, "{hosts} hosts");
        }
        assert_eq!(host_budget_mb(usize::MAX), 0);
        for hosts in 1..=300 {
            let budget = host_budget_mb(hosts) as usize;
            assert!(hosts * budget <= 250, "{hosts} hosts at {budget} MB");
            assert!(hosts > 250 || budget > 0, "{hosts} hosts at {budget} MB");
        }
    }
}
