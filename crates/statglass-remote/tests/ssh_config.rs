use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

use statglass_proto::{
    handover::HandoverReason,
    pairing::{BundleHostKey, BundleRoute, BundleTarget},
};
use statglass_remote::ssh_config::{
    HandoverInput, SshConfigError, handover_host, known_host_keys, parse_ssh_g, resolve,
};
use statglass_schema::HostId;
use uuid::Uuid;

fn checked(command: &mut Command) -> Output {
    let result = command.output().expect("run OpenSSH fixture command");
    assert!(
        result.status.success(),
        "{command:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    result
}

fn fixture_key(directory: &Path, algorithm: &str) -> (String, BundleHostKey) {
    let key = directory.join(algorithm);
    checked(
        Command::new("/usr/bin/ssh-keygen")
            .args(["-q", "-t", algorithm, "-N", "", "-f"])
            .arg(&key),
    );
    let public = key.with_extension("pub");
    let line = fs::read_to_string(&public).expect("read fixture public key");
    let fingerprint = checked(
        Command::new("/usr/bin/ssh-keygen")
            .args(["-lf"])
            .arg(&public),
    );
    let fingerprint = String::from_utf8(fingerprint.stdout).expect("read ssh-keygen output");
    let pin = BundleHostKey {
        algorithm: line
            .split_ascii_whitespace()
            .next()
            .expect("key algorithm")
            .into(),
        sha256: fingerprint
            .split_ascii_whitespace()
            .nth(1)
            .expect("key fingerprint")
            .into(),
    };
    (line, pin)
}

fn input(lan: &str, tailscale: Option<&str>) -> HandoverInput {
    HandoverInput {
        host_id: HostId(Uuid::from_u128(42)),
        name: "Build server".into(),
        os: "linux".into(),
        lan: Some(lan.into()),
        tailscale: tailscale.map(str::to_owned),
    }
}

fn config(directory: &Path, hosts: &str) -> PathBuf {
    let path = directory.join("ssh_config");
    let known_hosts = directory.join("known hosts");
    fs::write(
        &path,
        format!(
            "{hosts}\nHost *\nUser builder\nUserKnownHostsFile \"{}\"\nGlobalKnownHostsFile none\n",
            known_hosts.display()
        ),
    )
    .expect("write fixture SSH config");
    path
}

#[test]
fn parses_effective_ssh_fields_and_preserves_proxy_arguments() {
    let output = "host fixture\nhostname box.local\nuser me\nport\t2222\nproxyjump none\nproxycommand /usr/bin/nc -x proxy:8080 %h %p\n";
    let alias = parse_ssh_g(output).unwrap();
    assert_eq!(alias.hostname, "box.local");
    assert_eq!(alias.user, "me");
    assert_eq!(alias.port, 2222);
    assert_eq!(alias.proxy_jump, None);
    assert_eq!(
        alias.proxy_command.as_deref(),
        Some("/usr/bin/nc -x proxy:8080 %h %p")
    );
    for malformed in [
        output.replace("2222", "0"),
        output.replace("user me\n", ""),
        output.replace("2222", "65536"),
    ] {
        assert!(parse_ssh_g(&malformed).is_err());
    }
    let direct = parse_ssh_g(&output.replace("/usr/bin/nc -x proxy:8080 %h %p", "none")).unwrap();
    assert_eq!(direct.proxy_command, None);
}

#[test]
fn resolves_routes_in_order_and_reads_hashed_nonstandard_port_pins() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(
        dir.path(),
        "Host office\nHostName 192.168.4.5\nPort 2222\nHost tail\nHostName build.example.invalid\nPort 2222",
    );
    assert_eq!(
        resolve("tail", Some(&config)).unwrap().hostname,
        "build.example.invalid"
    );
    let (line, pin) = fixture_key(dir.path(), "ed25519");
    let (other, other_pin) = fixture_key(dir.path(), "ecdsa");
    let path = dir.path().join("known hosts");
    fs::write(&path, format!("[192.168.4.5]:2222 {line}[build.example.invalid]:2222 {line}[build.example.invalid]:2222 {other}")).unwrap();
    checked(
        Command::new("/usr/bin/ssh-keygen")
            .args(["-H", "-f"])
            .arg(&path),
    );
    assert!(
        fs::read_to_string(&path)
            .unwrap()
            .lines()
            .all(|line| line.starts_with("|1|"))
    );
    assert_eq!(
        known_host_keys("192.168.4.5", 2222, Some(&path))
            .unwrap()
            .as_slice(),
        std::slice::from_ref(&pin)
    );
    assert!(
        known_host_keys("192.168.4.5", 22, Some(&path))
            .unwrap()
            .is_empty()
    );

    let remote = input("office", Some("tail"));
    let host = handover_host(&remote, Some(&config)).unwrap();
    assert_eq!(host.host_id, remote.host_id);
    assert_eq!(host.name, remote.name);
    assert_eq!(host.os, remote.os);
    assert_eq!(host.user, "builder");
    assert_eq!(host.port, Some(2222));
    assert_eq!(
        host.targets,
        [
            BundleTarget {
                route: BundleRoute::Lan,
                host: "192.168.4.5".into()
            },
            BundleTarget {
                route: BundleRoute::Tailscale,
                host: "build.example.invalid".into()
            },
        ]
    );
    assert_eq!(host.host_keys.len(), 2);
    assert!(host.host_keys.contains(&pin));
    assert!(host.host_keys.contains(&other_pin));
}

#[test]
fn rejects_unavailable_routes_in_the_required_precedence() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("proxy-ran");
    let config = config(
        dir.path(),
        &format!(
            "Host jump\nHostName 192.168.0.1\nProxyJump gateway\nHost proxy\nHostName 169.254.2.1\nProxyCommand /usr/bin/touch {}\nHost private\nHostName 10.0.1.5\nHost cgnat\nHostName 100.127.8.9\nHost linklocal\nHostName fe80::1%%en0\nHost direct\nHostName build.invalid\n",
            marker.display(),
        ),
    );
    let reason = |lan, tail| handover_host(&input(lan, tail), Some(&config)).unwrap_err();
    assert_eq!(reason("proxy", Some("jump")), HandoverReason::ProxyJump);
    assert_eq!(reason("jump", None), HandoverReason::ProxyJump);
    assert_eq!(reason("proxy", None), HandoverReason::ProxyCommand);
    for literal in ["private", "cgnat", "linklocal"] {
        assert_eq!(
            reason(literal, None),
            HandoverReason::LanLiteral,
            "{literal}"
        );
        assert_eq!(
            reason(literal, Some("direct")),
            HandoverReason::NoHostKey,
            "{literal}"
        );
    }
    assert_eq!(reason("direct", None), HandoverReason::NoHostKey);
    assert_eq!(
        reason("private", Some("bad alias\n")),
        HandoverReason::LanLiteral,
    );
    assert_eq!(
        reason("direct", Some("bad alias\n")),
        HandoverReason::NoHostKey
    );
    let missing = dir.path().join("missing");
    assert_eq!(
        handover_host(&input("office", None), Some(&missing)).unwrap_err(),
        HandoverReason::Unresolvable
    );
    assert!(!marker.exists());
}

#[test]
fn uses_the_explicit_host_key_alias_but_never_pins_revoked_keys_or_cas() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(
        dir.path(),
        "Host office\nHostName office.local\nPort 2222\nHostKeyAlias stored",
    );
    let (line, pin) = fixture_key(dir.path(), "ed25519");
    let (ca, _) = fixture_key(dir.path(), "ecdsa");
    let file = dir.path().join("known hosts");
    fs::write(&file, format!("stored {line}@cert-authority stored {ca}")).unwrap();
    let remote = input("office", None);
    assert_eq!(
        handover_host(&remote, Some(&config)).unwrap().host_keys,
        [pin]
    );
    fs::write(
        &file,
        format!("stored {line}@revoked stored {line}@cert-authority stored {ca}"),
    )
    .unwrap();
    assert_eq!(
        handover_host(&remote, Some(&config)).unwrap_err(),
        HandoverReason::NoHostKey
    );
}

#[test]
fn rejects_two_routes_that_cannot_share_the_bundle_user_and_port() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(
        dir.path(),
        "Host office\nHostName office.local\nHost tail\nHostName tail.invalid\nUser other",
    );
    let (key, _) = fixture_key(dir.path(), "ed25519");
    fs::write(
        dir.path().join("known hosts"),
        format!("office.local {key}"),
    )
    .unwrap();
    assert_eq!(
        handover_host(&input("office", Some("tail")), Some(&config)).unwrap_err(),
        HandoverReason::Unresolvable
    );
    assert_eq!(
        handover_host(&input("office", Some("bad alias\n")), Some(&config)).unwrap_err(),
        HandoverReason::Unresolvable
    );
}

#[test]
fn a_port_qualified_pin_honors_bare_host_revocations_and_falls_back_to_a_bare_pin() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path(), "Host office\nHostName office.local\nPort 2222");
    let (line, pin) = fixture_key(dir.path(), "ed25519");
    let path = dir.path().join("known hosts");
    let remote = input("office", None);
    fs::write(&path, format!("office.local {line}")).unwrap();
    assert_eq!(
        handover_host(&remote, Some(&config)).unwrap().host_keys,
        [pin]
    );
    fs::write(
        &path,
        format!("[office.local]:2222 {line}@revoked office.local {line}"),
    )
    .unwrap();
    assert_eq!(
        handover_host(&remote, Some(&config)).unwrap_err(),
        HandoverReason::NoHostKey
    );
}

#[test]
fn never_offers_keys_revoked_in_an_openssh_list_or_krl() {
    let dir = tempfile::tempdir().unwrap();
    let revoked = dir.path().join("revoked");
    let config = config(
        dir.path(),
        &format!(
            "Host office\nHostName office.local\nRevokedHostKeys {}",
            revoked.display()
        ),
    );
    let (blocked, _) = fixture_key(dir.path(), "ed25519");
    let (other, pin) = fixture_key(dir.path(), "ecdsa");
    fs::write(
        dir.path().join("known hosts"),
        format!("office.local {blocked}office.local {other}"),
    )
    .unwrap();
    let remote = input("office", None);
    fs::write(&revoked, &blocked).unwrap();
    assert_eq!(
        handover_host(&remote, Some(&config))
            .unwrap()
            .host_keys
            .as_slice(),
        std::slice::from_ref(&pin)
    );
    fs::remove_file(&revoked).unwrap();
    checked(
        Command::new("/usr/bin/ssh-keygen")
            .args(["-k", "-f"])
            .arg(&revoked)
            .arg(dir.path().join("ed25519.pub")),
    );
    assert_eq!(
        handover_host(&remote, Some(&config)).unwrap().host_keys,
        [pin]
    );
}

#[test]
fn reads_known_host_paths_that_mix_absolute_and_relative_names() {
    let directory = tempfile::tempdir().unwrap();
    let (key, pin) = fixture_key(directory.path(), "ed25519");
    let actual = directory.path().join("relative");
    fs::write(&actual, format!("office.local {key}")).unwrap();
    let cwd_depth = std::env::current_dir().unwrap().components().count() - 1;
    let relative = format!(
        "{}{}",
        "../".repeat(cwd_depth),
        actual.strip_prefix("/").unwrap().display()
    );
    let config = config(
        directory.path(),
        &format!(
            "Host office\nHostName office.local\nUserKnownHostsFile {} {relative}",
            directory.path().join("missing").display()
        ),
    );
    assert_eq!(
        handover_host(&input("office", None), Some(&config))
            .unwrap()
            .host_keys,
        [pin]
    );
}

#[test]
fn ssh_config_match_exec_timeout_is_a_typed_resolution_error() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("blocked");
    checked(Command::new("/usr/bin/mkfifo").arg(&fifo));
    let config = config(
        dir.path(),
        &format!("Match exec \"/bin/cat {}\"", fifo.display()),
    );
    assert!(matches!(
        resolve("office", Some(&config)),
        Err(SshConfigError::Io(error)) if error.kind() == std::io::ErrorKind::TimedOut
    ));
}
