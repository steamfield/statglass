//! The iPhones paired with this host: `devices` lists them with their last-seen time,
//! `devices revoke <tag>` removes one's `authorized_keys` line.
use anyhow::Context;
use statglass_remote::{
    AgentEnv, AgentLayout, AuthorizedKeys, DeviceKeys, DeviceSeenLog, DeviceTag,
};

pub(crate) fn seen_log() -> anyhow::Result<DeviceSeenLog> {
    let layout = AgentLayout::for_uid(rustix::process::geteuid().as_raw());
    // The SSH login and the service can have different XDG environments and
    // history paths. This log belongs to the login, alongside its default state.
    let env = AgentEnv {
        xdg_state_home: None,
        ..AgentEnv::from_process()
    };
    let paths = layout.paths(&env).context("locating device seen state")?;
    Ok(DeviceSeenLog::new(paths.data_dir.join("device-seen.jsonl")))
}

/// Prints each paired device's tag, name, fingerprint and last-seen time in epoch ms.
pub fn list() -> anyhow::Result<()> {
    let devices = AuthorizedKeys::for_current_user()?
        .list_devices()
        .context("listing paired devices")?;
    if devices.is_empty() {
        return Ok(());
    }
    let seen = seen_log()?.read();
    for device in devices {
        let last_seen = seen
            .get(&device.tag)
            .map_or_else(|| "never".into(), i64::to_string);
        println!(
            "{}\t{}\t{}\t{}",
            device.tag, device.name, device.fingerprint, last_seen
        );
    }
    Ok(())
}

/// Removes `tag`'s device line. Returns false when no device has that tag.
pub fn revoke(tag: &str) -> anyhow::Result<bool> {
    let device = DeviceTag::parse(tag).context("expected a six-digit uppercase hex device tag")?;
    AuthorizedKeys::for_current_user()?
        .revoke(device)
        .with_context(|| format!("revoking device {tag}"))
}
