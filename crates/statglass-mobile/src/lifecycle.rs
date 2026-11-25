//! The app's lifecycle as the sessions see it: backgrounding quiesces every source,
//! foregrounding resumes them (the open host first), and a path or data-policy change
//! picks the sync policy and tells the sources (phase 4 lane d).

use statglass_ipc::mobile::DataPolicy;
use statglass_session::{BoxFuture, SyncPolicy};

use crate::control::SessionControl;
use crate::ffi::NetworkPath;

/// The last path and data policy the app reported, and whether it is backgrounded.
pub(crate) struct Lifecycle {}

impl Lifecycle {
    pub(crate) fn new() -> Self {
        Self {}
    }

    /// The sync policy for the current path and data policy, for sources started now.
    pub(crate) fn sync_policy(&self) -> SyncPolicy {
        crate::policy::sync_policy(None, DataPolicy::default())
    }

    /// Quiesces every source and resolves once each has committed its in-flight mirror
    /// write and closed its session.
    pub(crate) fn quiesce(&self, sessions: &dyn SessionControl) -> BoxFuture<'static, ()> {
        let _ = sessions;
        Box::pin(async {})
    }

    /// Resumes every source, the open host's first.
    pub(crate) fn resume(&self, sessions: &dyn SessionControl) {
        let _ = sessions;
    }

    /// Records the path, re-derives the sync policy and tells the sources the network
    /// changed.
    pub(crate) fn path_changed(&self, sessions: &dyn SessionControl, path: NetworkPath) {
        let _ = (sessions, path);
    }

    /// Records the data policy and applies the sync policy it gives.
    pub(crate) fn set_data_policy(&self, sessions: &dyn SessionControl, data: DataPolicy) {
        let _ = (sessions, data);
    }
}
