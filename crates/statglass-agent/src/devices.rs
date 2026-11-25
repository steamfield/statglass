//! The iPhones paired with this host: `devices` lists them with their last-seen time,
//! `devices revoke <tag>` removes one's `authorized_keys` line.
use std::io::{self, Write};

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
    let keys = AuthorizedKeys::for_current_user()?;
    list_to(&keys, seen_log, io::stdout().lock())
}

fn list_to(
    keys: &AuthorizedKeys,
    seen_log: impl FnOnce() -> anyhow::Result<DeviceSeenLog>,
    mut out: impl Write,
) -> anyhow::Result<()> {
    let devices = keys.list_devices().context("listing paired devices")?;
    if devices.is_empty() {
        return Ok(());
    }
    let seen = seen_log()?.read();
    for device in devices {
        let last_seen = seen
            .get(&device.tag)
            .map_or_else(|| "never".into(), i64::to_string);
        writeln!(
            out,
            "{}\t{}\t{}\t{}",
            device.tag, device.name, device.fingerprint, last_seen
        )
        .context("writing the paired devices list")?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use statglass_remote::EcdsaP256Public;

    #[test]
    fn missing_authorized_keys_leaves_an_empty_list() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join(".ssh");
        let keys = AuthorizedKeys::at(directory.join("authorized_keys"));
        let mut list = Vec::new();
        list_to(
            &keys,
            || panic!("an empty list has no last-seen records"),
            &mut list,
        )
        .unwrap();
        assert!(list.is_empty());
        assert!(!keys.revoke(DeviceTag::parse("7F3A2C").unwrap()).unwrap());
        assert!(!directory.exists());
    }

    #[test]
    fn lists_key_fingerprints_and_last_seen_for_paired_devices() {
        if crate::test_support::reexec_for_lock_test() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let keys = AuthorizedKeys::at(home.path().join(".ssh/authorized_keys"));
        let seen = || Ok(DeviceSeenLog::new(home.path().join("device-seen.jsonl")));
        // Both points are the P-256 generator and its negation.
        let mut a = [
            4, 107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3,
            125, 129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150, 79, 227, 66, 226,
            254, 26, 127, 155, 142, 231, 235, 74, 124, 15, 158, 22, 43, 206, 51, 87, 107, 49, 94,
            206, 203, 182, 64, 104, 55, 191, 81, 245,
        ];
        let add = |point, name| {
            let key = EcdsaP256Public(point);
            let tag = DeviceTag::from_key(&key);
            assert_eq!(
                keys.add_device(
                    &key,
                    name,
                    &format!("/opt/helper restricted --device {tag}")
                )
                .unwrap(),
                tag
            );
            tag
        };
        let first = add(a, "Phone");
        a[33..].copy_from_slice(&[
            176, 28, 189, 28, 1, 229, 128, 101, 113, 24, 20, 181, 131, 240, 97, 233, 212, 49, 204,
            169, 148, 206, 161, 49, 52, 73, 191, 151, 200, 64, 174, 10,
        ]);
        let other = add(a, "Tablet");
        seen().unwrap().record(first, 123456);

        let mut list = Vec::new();
        list_to(&keys, seen, &mut list).unwrap();
        let rows = keys.list_devices().unwrap();
        let expected = format!(
            "{first}\tPhone\t{}\t123456\n{other}\tTablet\t{}\tnever\n",
            rows[0].fingerprint, rows[1].fingerprint,
        );
        assert_eq!(list, expected.as_bytes());

        assert!(keys.revoke(first).unwrap());
        assert!(!keys.revoke(first).unwrap());
        list.clear();
        list_to(&keys, seen, &mut list).unwrap();
        assert_eq!(
            list,
            format!("{other}\tTablet\t{}\tnever\n", rows[1].fingerprint).as_bytes()
        );
    }
}
