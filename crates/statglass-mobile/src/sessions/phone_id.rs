use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use statglass_engine::identity;
use statglass_ipc::error::CommandError;
use statglass_schema::HostId;
use statglass_store::{WriterLock, create_private_dir};

use super::internal;

pub(super) fn load(dir: &Path) -> Result<HostId, CommandError> {
    create_private_dir(dir).map_err(|error| {
        internal(format!(
            "creating phone data directory {}: {error}",
            dir.display()
        ))
    })?;
    let path = dir.join("phone-id");
    let read = || match fs::read_to_string(&path) {
        Ok(text) => text.trim().parse().map(HostId).map(Some).map_err(|error| {
            internal(format!(
                "invalid phone identity in {}: {error}",
                path.display()
            ))
        }),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(internal(format!("reading {}: {error}", path.display()))),
    };
    if let Some(id) = read()? {
        return Ok(id);
    }

    // Serialize first use across cores. The engine writes its UUID atomically in
    // staging, so readers only ever see a complete phone-id.
    let _lock = WriterLock::acquire(&path)?;
    if let Some(id) = read()? {
        return Ok(id);
    }
    let staging = dir.join(".phone-id");
    let id = identity::reset(&staging, |_| None)
        .map_err(|error| internal(format!("creating {}: {error}", path.display())))?;
    fs::rename(staging.join(identity::HOST_ID_FILE), &path)
        .map_err(|error| internal(format!("installing {}: {error}", path.display())))?;
    if let Err(error) = fs::remove_dir(&staging) {
        tracing::warn!(%error, path = %staging.display(), "removing phone identity staging directory");
    }
    Ok(id)
}
