//! The file-backed [`DeviceKeys`]: StatGlass's edits to `~/.ssh/authorized_keys` (RFC
//! `plan/rfc-ios-app.md` 2.5). Only `statglass-mobile:` and `statglass-pairing:` lines
//! are added or removed; every other line is kept byte for byte.
//!
//! Scaffold: phase 5 lane a implements the parser and the atomic, locked edits.
use crate::device_keys::{DeviceKeys, DeviceKeysError, DeviceTag, EcdsaP256Public, PairedDevice};
use std::path::PathBuf;

/// One `authorized_keys` file, symlinks followed.
pub struct AuthorizedKeys {
    path: PathBuf,
}

impl AuthorizedKeys {
    /// `~/.ssh/authorized_keys` of the user running this process.
    pub fn for_current_user() -> Result<Self, DeviceKeysError> {
        let home = std::env::var_os("HOME").ok_or_else(|| {
            DeviceKeysError::Invalid("HOME is not set, so ~/.ssh cannot be found".into())
        })?;
        Ok(Self::at(PathBuf::from(home).join(".ssh/authorized_keys")))
    }

    /// The file at `path`.
    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }
}

/// Scaffold stubs: every method returns [`DeviceKeysError::NotImplemented`] until phase 5
/// lane a.
impl DeviceKeys for AuthorizedKeys {
    fn list_devices(&self) -> Result<Vec<PairedDevice>, DeviceKeysError> {
        let _ = &self.path;
        Err(DeviceKeysError::NotImplemented)
    }

    fn add_device(
        &self,
        key: &EcdsaP256Public,
        name: &str,
        command: &str,
    ) -> Result<DeviceTag, DeviceKeysError> {
        let _ = (key, name, command);
        Err(DeviceKeysError::NotImplemented)
    }

    fn revoke(&self, tag: DeviceTag) -> Result<bool, DeviceKeysError> {
        let _ = tag;
        Err(DeviceKeysError::NotImplemented)
    }

    fn add_pairing(
        &self,
        key: &EcdsaP256Public,
        nonce: &str,
        expires_ms: i64,
        command: &str,
    ) -> Result<(), DeviceKeysError> {
        let _ = (key, nonce, expires_ms, command);
        Err(DeviceKeysError::NotImplemented)
    }

    fn remove_pairing(&self, nonce: &str) -> Result<bool, DeviceKeysError> {
        let _ = nonce;
        Err(DeviceKeysError::NotImplemented)
    }
}
