use anyhow::{Context, ensure};
use statglass_proto::pairing::{BundleHost, BundleHostKey, BundleRoute, BundleTarget};
use statglass_remote::{
    AgentLayout, AgentPaths, MAX_TARGETS,
    network::{AddressClass, classify_address, counts_toward_online, usable_interface_addresses},
};
use std::{ffi::OsString, net::IpAddr, path::Path, process::Command};

pub(super) async fn bundle(
    layout: AgentLayout,
    paths: &AgentPaths,
    user: OsString,
) -> anyhow::Result<BundleHost> {
    let status = crate::commands::status(layout, paths).await;
    ensure!(
        status["running"].as_bool() == Some(true),
        "start the StatGlass agent on {} before pairing",
        paths.socket.display()
    );
    let id = status["host_id"]
        .as_str()
        .context("the agent did not report a host identity")?
        .parse()
        .context("decoding the agent's host identity")?;
    let info = statglass_engine::host_record(statglass_schema::HostId(id));
    let user = user
        .into_string()
        .ok()
        .context("the SSH login is not UTF-8")?;
    let addresses =
        usable_interface_addresses().context("reading this host's interface addresses")?;
    let targets = bundle_targets(&info.display_name, &addresses);
    ensure!(
        !targets.is_empty(),
        "this host has no LAN or Tailscale address for the phone to dial"
    );
    let host_keys = host_keys(Path::new("/etc/ssh")).context(
        "Pairing uses OpenSSH on port 22 with standard SSH host public-key files in /etc/ssh",
    )?;
    Ok(BundleHost {
        host_id: info.id,
        name: info.display_name,
        os: std::env::consts::OS.into(),
        user,
        port: None,
        targets,
        host_keys,
    })
}

fn bundle_targets(hostname: &str, addresses: &[(String, IpAddr)]) -> Vec<BundleTarget> {
    let mut lan = Vec::new();
    let mut tailscale = Vec::new();
    for (name, address) in addresses {
        let (targets, route) = match classify_address(*address) {
            AddressClass::Ignored => continue,
            AddressClass::Tailscale if name.starts_with("tailscale") => {
                (&mut tailscale, BundleRoute::Tailscale)
            }
            _ if counts_toward_online(name)
                && !["br-", "virbr", "tun", "tap", "wg"]
                    .iter()
                    .any(|prefix| name.starts_with(prefix)) =>
            {
                (&mut lan, BundleRoute::Lan)
            }
            _ => continue,
        };
        let target = BundleTarget {
            route,
            host: address.to_string(),
        };
        if !targets.contains(&target) && targets.len() < MAX_TARGETS {
            targets.push(target);
        }
    }
    let hostname = hostname.trim_end_matches('.');
    if !lan.is_empty()
        && !hostname.is_empty()
        && hostname
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        && !hostname.starts_with('-')
    {
        lan.retain(|target| target.host != hostname);
        lan.insert(
            0,
            BundleTarget {
                route: BundleRoute::Lan,
                host: hostname.into(),
            },
        );
    }
    tailscale.sort_by_key(|target| target.host.contains(':'));
    lan.truncate(MAX_TARGETS - usize::from(!tailscale.is_empty()));
    lan.extend(tailscale);
    lan.truncate(MAX_TARGETS);
    lan
}

fn host_keys(dir: &Path) -> anyhow::Result<Vec<BundleHostKey>> {
    let mut keys = Vec::new();
    let paths = std::fs::read_dir(dir)
        .with_context(|| format!("reading SSH host keys in {}", dir.display()))?;
    for path in paths {
        let path = path?.path();
        if !path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|name| name.starts_with("ssh_host_") && name.ends_with("_key.pub"))
        {
            continue;
        }
        let public = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let algorithm = public
            .split_whitespace()
            .next()
            .with_context(|| format!("{} has no SSH key", path.display()))?;
        let output = Command::new("ssh-keygen")
            .args(["-l", "-E", "sha256", "-f"])
            .arg(&path)
            .output()
            .with_context(|| format!("fingerprinting {}", path.display()))?;
        ensure!(
            output.status.success(),
            "ssh-keygen could not fingerprint {}",
            path.display()
        );
        let line = String::from_utf8_lossy(&output.stdout);
        let sha256 = line
            .split_whitespace()
            .nth(1)
            .filter(|value| value.starts_with("SHA256:"))
            .with_context(|| format!("{} has no SHA256 fingerprint", path.display()))?;
        keys.push(BundleHostKey {
            algorithm: algorithm.into(),
            sha256: sha256.into(),
        });
    }
    ensure!(
        !keys.is_empty(),
        "no SSH host public keys found in {}",
        dir.display()
    );
    keys.sort_by(|a, b| {
        a.algorithm
            .cmp(&b.algorithm)
            .then_with(|| a.sha256.cmp(&b.sha256))
    });
    Ok(keys)
}

pub(super) fn check_ssh_version() -> anyhow::Result<()> {
    let version = match Command::new("ssh").arg("-V").output() {
        Ok(output) => {
            let mut version = output.stderr;
            version.extend(output.stdout);
            version
        }
        Err(error) => {
            tracing::warn!(
                error = &error as &dyn std::error::Error,
                "could not check the OpenSSH version"
            );
            return Ok(());
        }
    };
    if let Some(version) = openssh_version(&String::from_utf8_lossy(&version)) {
        ensure!(
            version >= (7, 7),
            "pairing requires OpenSSH 7.7 or later for expiring SSH keys; update OpenSSH and retry"
        );
    } else {
        tracing::warn!("could not recognize the OpenSSH version");
    }
    Ok(())
}

fn openssh_version(output: &str) -> Option<(u32, u32)> {
    let (_, version) = output.split_once("OpenSSH_")?;
    let (major, rest) = version.split_once('.')?;
    let minor = rest.split(|ch: char| !ch.is_ascii_digit()).next()?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_targets_deduplicate_usable_addresses_with_space_for_tailscale() {
        let targets = bundle_targets(
            "",
            &interfaces(&[
                ("lo", "127.0.0.1"),
                ("eth0", "fe80::1"),
                ("tailscale0", "100.64.17.2"),
                ("eth0", "192.168.0.1"),
                ("eth0", "192.168.0.1"),
                ("eth1", "10.0.0.1"),
                ("eth2", "10.0.0.2"),
                ("eth3", "10.0.0.3"),
            ]),
        );
        assert_eq!(
            targets
                .iter()
                .map(|target| (target.route, target.host.as_str()))
                .collect::<Vec<_>>(),
            [
                (BundleRoute::Lan, "192.168.0.1"),
                (BundleRoute::Lan, "10.0.0.1"),
                (BundleRoute::Lan, "10.0.0.2"),
                (BundleRoute::Tailscale, "100.64.17.2"),
            ]
        );
        assert!(
            bundle_targets(
                "tower.local",
                &interfaces(&[("lo", "127.0.0.1"), ("lo", "::1")])
            )
            .is_empty()
        );
    }

    fn interfaces(entries: &[(&str, &str)]) -> Vec<(String, IpAddr)> {
        entries
            .iter()
            .map(|(name, addr)| ((*name).into(), addr.parse().expect("fixture interface IP")))
            .collect()
    }

    #[test]
    fn pair_preserves_the_hostname_and_physical_lan_on_a_host_with_virtual_routes() {
        let targets = bundle_targets(
            "tower.local",
            &interfaces(&[
                ("docker0", "172.17.0.1"),
                ("br-deadbeef", "10.0.9.1"),
                ("wg0", "10.0.9.2"),
                ("eth0", "100.90.2.1"),
                ("eth1", "10.1.2.3"),
                ("tailscale0", "100.64.0.1"),
            ]),
        );
        assert_eq!(
            targets
                .iter()
                .map(|target| (target.route, target.host.as_str()))
                .collect::<Vec<_>>(),
            [
                (BundleRoute::Lan, "tower.local"),
                (BundleRoute::Lan, "100.90.2.1"),
                (BundleRoute::Lan, "10.1.2.3"),
                (BundleRoute::Tailscale, "100.64.0.1"),
            ]
        );
    }

    #[test]
    fn pair_version_parser_handles_openssh_package_versions() {
        assert_eq!(openssh_version("OpenSSH_7.6p1, OpenSSL 3.0"), Some((7, 6)));
        assert_eq!(
            openssh_version("OpenSSH_7.7p2 Debian-2, OpenSSL 3.0"),
            Some((7, 7))
        );
        assert_eq!(
            openssh_version("OpenSSH_10.1p1, LibreSSL 3.3.6"),
            Some((10, 1))
        );
        assert_eq!(openssh_version("Dropbear v2025.89"), None);
    }
}
