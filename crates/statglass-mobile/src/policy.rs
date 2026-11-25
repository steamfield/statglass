use statglass_ipc::mobile::DataPolicy;

use crate::ffi::NetworkPath;

pub(crate) fn live_allowed(path: Option<NetworkPath>, data: DataPolicy) -> bool {
    data.live_on_cellular || !path.is_some_and(|path| path.expensive || path.constrained)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_updates_on_limited_paths_require_the_cellular_switch() {
        for (expensive, constrained) in [(false, false), (true, false), (false, true), (true, true)]
        {
            let path = Some(NetworkPath {
                satisfied: true,
                expensive,
                constrained,
            });
            assert_eq!(
                live_allowed(path, DataPolicy::default()),
                !expensive && !constrained
            );
            assert!(live_allowed(
                path,
                DataPolicy {
                    live_on_cellular: true
                }
            ));
        }
        assert!(live_allowed(None, DataPolicy::default()));
    }
}
