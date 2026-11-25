use std::{
    ffi::{CString, c_char, c_int},
    io::{self, Read},
    net::{IpAddr, SocketAddr, TcpStream},
    path::Path,
    process::Command,
    time::Duration,
};

use anyhow::{Context, ensure};
use statglass_proto::pairing::{
    BundleHost, BundleHostKey, BundleRoute, BundleTarget, PairingPayload,
};
use statglass_remote::network::usable_interface_addresses;
use statglass_remote::{PairingError, PairingHost};
use statglass_schema::HostRecord;

pub(super) const MONITORING_OFF: &str =
    "Turn on Allow remote monitoring in StatGlass Settings, then try pairing again.";

pub(super) fn check_monitoring(enabled: bool) -> anyhow::Result<()> {
    ensure!(enabled, "{MONITORING_OFF}");
    Ok(())
}

pub(super) fn offer(
    host: &PairingHost,
    bundle: BundleHost,
    now_ms: i64,
) -> Result<PairingPayload, PairingError> {
    let mut payload = host.offer(bundle, Duration::ZERO, now_ms)?;
    payload.can_hand_over = true;
    Ok(payload)
}

pub(super) fn build(record: &HostRecord) -> anyhow::Result<BundleHost> {
    let login = Command::new("/bin/launchctl")
        .args(["print", "system/com.openssh.sshd"])
        .output()
        .context("Check Remote Login in System Settings › General › Sharing, then try again")?;
    check_remote_login(login.status.success())?;
    let ssh = Command::new("/usr/bin/ssh")
        .arg("-V")
        .output()
        .context("checking the macOS OpenSSH version")?;
    check_ssh_version(&String::from_utf8_lossy(&ssh.stderr))?;
    let name = command_text("/usr/sbin/scutil", &["--get", "LocalHostName"])?;
    let user = std::env::var("USER").context("reading the macOS SSH login name (USER)")?;
    ensure!(
        !user.is_empty(),
        "The macOS SSH login name (USER) is empty."
    );
    check_ssh_access(&user)?;
    let addresses = usable_interface_addresses().context("reading network interfaces")?;
    Ok(BundleHost {
        host_id: record.id,
        name: record.display_name.clone(),
        os: format!("macOS {}", record.info.os_version),
        user,
        port: None,
        targets: targets(&name, &addresses),
        host_keys: host_keys(Path::new("/etc/ssh"), activate_sshd)?,
    })
}

// Public macOS membership.h APIs, including nested membership in Remote Login's allowlist.
unsafe extern "C" {
    fn mbr_user_name_to_uuid(user: *const c_char, uuid: *mut u8) -> c_int;
    fn mbr_check_service_membership(
        uuid: *const u8,
        service: *const c_char,
        member: *mut c_int,
    ) -> c_int;
}

fn check_ssh_access(user: &str) -> anyhow::Result<()> {
    let name = CString::new(user).context("reading the macOS SSH login name")?;
    let mut uuid = [0; 16];
    // SAFETY: name is NUL-terminated and uuid is writable for the 16-byte result.
    let result = unsafe { mbr_user_name_to_uuid(name.as_ptr(), uuid.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result)).context(
            "Check Remote Login for this Mac account in System Settings › General › Sharing",
        );
    }
    let mut member = 0;
    // SAFETY: uuid is initialized, the service is NUL-terminated, and member is writable.
    let result =
        unsafe { mbr_check_service_membership(uuid.as_ptr(), c"ssh".as_ptr(), &mut member) };
    check_service_membership(user, result, member)
}

fn check_service_membership(user: &str, result: c_int, member: c_int) -> anyhow::Result<()> {
    match result {
        // A missing ACL means Remote Login is open to every user.
        libc::ENOENT => Ok(()),
        0 => {
            ensure!(
                member != 0,
                "Allow {user} in Remote Login in System Settings › General › Sharing, then try pairing again."
            );
            Ok(())
        }
        result => Err(io::Error::from_raw_os_error(result)).context(
            "Check Remote Login for this Mac account in System Settings › General › Sharing",
        ),
    }
}

fn check_remote_login(loaded: bool) -> anyhow::Result<()> {
    ensure!(
        loaded,
        "Check Remote Login in System Settings › General › Sharing. Turn it on, then try pairing again."
    );
    Ok(())
}

fn command_text(program: &str, args: &[&str]) -> anyhow::Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("running {program}"))?;
    ensure!(output.status.success(), "{program} did not return a value");
    let text =
        String::from_utf8(output.stdout).with_context(|| format!("reading {program} output"))?;
    ensure!(!text.trim().is_empty(), "{program} returned an empty value");
    Ok(text.trim().to_owned())
}

fn check_ssh_version(output: &str) -> anyhow::Result<()> {
    if let Some((major, minor)) = openssh_version(output) {
        ensure!(
            (major, minor) >= (7, 7),
            "Pairing requires OpenSSH 7.7 or later. Update macOS, then try again."
        );
    } else {
        tracing::warn!("could not identify the macOS OpenSSH version");
    }
    Ok(())
}

fn openssh_version(output: &str) -> Option<(u32, u32)> {
    let (major, minor) = output.trim().strip_prefix("OpenSSH_")?.split_once('.')?;
    let minor = minor.split(|char: char| !char.is_ascii_digit()).next()?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

fn targets(name: &str, addresses: &[(String, IpAddr)]) -> Vec<BundleTarget> {
    let mut targets = vec![BundleTarget {
        route: BundleRoute::Lan,
        host: format!("{name}.local"),
    }];
    let tailscale = addresses.iter().find_map(|(interface, ip)| {
        let IpAddr::V4(ip) = ip else { return None };
        let [a, b, ..] = ip.octets();
        (a == 100
            && (64..=127).contains(&b)
            && (interface.starts_with("utun") || interface.starts_with("tailscale")))
        .then_some(ip)
    });
    if let Some(ip) = tailscale {
        targets.push(BundleTarget {
            route: BundleRoute::Tailscale,
            host: ip.to_string(),
        });
    }
    targets
}

fn activate_sshd() -> io::Result<()> {
    let timeout = Duration::from_secs(5);
    let address = SocketAddr::from(([127, 0, 0, 1], 22));
    let mut stream = TcpStream::connect_timeout(&address, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    // launchd's SSH wrapper generates absent host keys before sshd writes its banner.
    stream.read_exact(&mut [0])
}

fn host_keys(
    dir: &Path,
    activate: impl FnOnce() -> io::Result<()>,
) -> anyhow::Result<Vec<BundleHostKey>> {
    let mut keys = read_host_keys(dir)?;
    if keys.is_empty() {
        activate().context("Check Remote Login in System Settings › General › Sharing. Could not reach this Mac's SSH listener")?;
        keys = read_host_keys(dir)?;
    }
    ensure!(
        !keys.is_empty(),
        "No SSH host public keys were found in {}. Check Remote Login in System Settings › General › Sharing.",
        dir.display()
    );
    Ok(keys)
}

fn read_host_keys(dir: &Path) -> anyhow::Result<Vec<BundleHostKey>> {
    let names = [
        ("ssh_host_ed25519_key.pub", "ssh-ed25519"),
        ("ssh_host_ecdsa_key.pub", "ecdsa-sha2-"),
    ];
    let mut keys = Vec::new();
    for (file, expected) in names {
        let path = dir.join(file);
        let public = match std::fs::read_to_string(&path) {
            Ok(public) => public,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
        };
        let algorithm = public
            .split_whitespace()
            .next()
            .filter(|algorithm| {
                *algorithm == expected
                    || (expected == "ecdsa-sha2-" && algorithm.starts_with(expected))
            })
            .with_context(|| format!("reading the SSH key algorithm from {}", path.display()))?;
        let output = Command::new("/usr/bin/ssh-keygen")
            .args(["-l", "-E", "sha256", "-f"])
            .arg(&path)
            .output()
            .with_context(|| format!("fingerprinting {}", path.display()))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let sha256 = stdout
            .split_whitespace()
            .nth(1)
            .filter(|value| output.status.success() && value.starts_with("SHA256:"))
            .with_context(|| format!("reading the SHA-256 fingerprint for {}", path.display()))?;
        keys.push(BundleHostKey {
            algorithm: algorithm.into(),
            sha256: sha256.into(),
        });
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_preflight_explains_disabled_monitoring_and_old_ssh() {
        assert!(
            check_monitoring(false)
                .unwrap_err()
                .to_string()
                .contains("Allow remote monitoring")
        );
        assert!(
            check_remote_login(false)
                .unwrap_err()
                .to_string()
                .contains("Check Remote Login")
        );
        assert!(
            check_ssh_version("OpenSSH_7.6p1, LibreSSL")
                .unwrap_err()
                .to_string()
                .contains("OpenSSH 7.7")
        );
        check_monitoring(true).unwrap();
        check_remote_login(true).unwrap();
        check_ssh_version("OpenSSH_7.7p1, LibreSSL").unwrap();
        check_ssh_version("OpenSSH_10.0p2, LibreSSL").unwrap();
    }

    #[test]
    fn pairing_bundle_advertises_local_name_and_only_a_tailscale_range_tunnel() {
        let ip = |value: &str| value.parse().unwrap();
        let links = [
            ("en0".into(), ip("100.72.0.1")),
            ("utun2".into(), ip("100.10.0.1")),
            ("utun3".into(), ip("100.80.0.2")),
        ];
        assert_eq!(
            targets("studio", &links),
            [
                BundleTarget {
                    route: BundleRoute::Lan,
                    host: "studio.local".into()
                },
                BundleTarget {
                    route: BundleRoute::Tailscale,
                    host: "100.80.0.2".into()
                },
            ]
        );
        assert_eq!(targets("studio", &[]).len(), 1);
    }

    #[test]
    fn pairing_bundle_fingerprints_existing_standard_keys_and_reports_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            host_keys(dir.path(), || Ok(()))
                .unwrap_err()
                .to_string()
                .contains("No SSH host public keys")
        );
        let pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA fixture\n";
        std::fs::write(dir.path().join("ssh_host_ed25519_key.pub"), pubkey).unwrap();
        let keys = host_keys(dir.path(), || {
            panic!("an initialized server needs no activation")
        })
        .unwrap();
        assert_eq!(keys[0].algorithm, "ssh-ed25519");
        assert!(keys[0].sha256.starts_with("SHA256:"));
        assert_eq!(keys.len(), 1);
    }

    #[test]
    fn pairing_bundle_activates_a_first_use_ssh_listener_before_reading_its_keys() {
        let dir = tempfile::tempdir().unwrap();
        let keys = host_keys(dir.path(), || {
            std::fs::write(
                dir.path().join("ssh_host_ed25519_key.pub"),
                "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA fixture\n",
            )
        }).unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].algorithm, "ssh-ed25519");
    }

    #[test]
    fn pairing_preflight_distinguishes_excluded_accounts_from_unrestricted_ssh() {
        assert!(
            check_service_membership("tester", 0, 0)
                .unwrap_err()
                .to_string()
                .contains("Allow tester")
        );
        check_service_membership("tester", 0, 1).unwrap();
        check_service_membership("tester", libc::ENOENT, 0).unwrap();
        assert!(
            check_service_membership("tester", libc::EIO, 0)
                .unwrap_err()
                .to_string()
                .contains("Check Remote Login")
        );
    }
}
