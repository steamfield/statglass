use std::path::{Path, PathBuf};

use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::MobileHost;

pub(crate) struct HostStore {
    path: PathBuf,
}

impl HostStore {
    pub(crate) fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("hosts.json"),
        }
    }

    pub(crate) fn load(&self) -> Vec<MobileHost> {
        let _ = &self.path;
        Vec::new()
    }

    pub(crate) fn save(&self, _hosts: &[MobileHost]) -> Result<(), CommandError> {
        Ok(())
    }
}

// The persistence lane will wire these into the registry.
const _: fn(&Path) -> HostStore = HostStore::new;
const _: fn(&HostStore) -> Vec<MobileHost> = HostStore::load;
const _: fn(&HostStore, &[MobileHost]) -> Result<(), CommandError> = HostStore::save;
