//! The iPhones paired with this host: `devices` lists them with their last-seen time,
//! `devices revoke <tag>` removes one's `authorized_keys` line.
//!
//! Scaffold: phase 5 lane a implements both.

/// Prints each paired device's tag, name, fingerprint and last-seen time. Scaffold stub:
/// not implemented until phase 5 lane a.
pub fn list() -> anyhow::Result<()> {
    Err(anyhow::anyhow!(
        "listing devices is not implemented in this build"
    ))
}

/// Removes `tag`'s device line; false when no device has that tag. Scaffold stub: not
/// implemented until phase 5 lane a.
pub fn revoke(tag: &str) -> anyhow::Result<bool> {
    Err(anyhow::anyhow!(
        "revoking device {tag} is not implemented in this build"
    ))
}
