use statglass_remote::{AuthorizedKeys, DeviceKeys, DeviceTag, EcdsaP256Public, PairedDevice};
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;
use std::process::Command;

// The P-256 generator, encoded as a SEC1 point and as an OpenSSH public key.
const POINT: [u8; 65] = [
    4, 107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125, 129,
    45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150, 79, 227, 66, 226, 254, 26, 127, 155,
    142, 231, 235, 74, 124, 15, 158, 22, 43, 206, 51, 87, 107, 49, 94, 206, 203, 182, 64, 104, 55,
    191, 81, 245,
];
const BLOB: &str = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=";
const COMMAND: &str = r#"'/Applications/A "quoted" path/helper' restricted --device 698BEA"#;
const NONCE: &str = "0000000000000000000000000000000a";
const PAIR_COMMAND: &str = "/opt/helper pair --nonce 0000000000000000000000000000000a";

fn other_key() -> EcdsaP256Public {
    // Negating the generator's y coordinate gives a second valid P-256 key.
    let mut point = POINT;
    point[33..].copy_from_slice(&[
        176, 28, 189, 28, 1, 229, 128, 101, 113, 24, 20, 181, 131, 240, 97, 233, 212, 49, 204, 169,
        148, 206, 161, 49, 52, 73, 191, 151, 200, 64, 174, 10,
    ]);
    EcdsaP256Public(point)
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path)
        .expect("read the fixture's mode")
        .permissions()
        .mode()
        & 0o777
}

fn localtime() -> jiff::tz::TimeZone {
    let bytes = fs::read("/etc/localtime").expect("read the host's sshd time zone");
    jiff::tz::TimeZone::tzif("localtime", &bytes).expect("parse the host's sshd time zone")
}

#[test]
fn adding_an_offer_prunes_only_expired_pairing_lines() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authorized_keys");
    let keys = AuthorizedKeys::at(path.clone());
    let expired = "0000000000000000000000000000000b";
    let fresh = "0000000000000000000000000000000c";
    let past = jiff::Timestamp::from_second(1_300_000_000).unwrap();
    let future = jiff::Timestamp::from_second(2_000_000_000).unwrap();
    keys.add_pairing(
        &EcdsaP256Public(POINT),
        expired,
        past.as_millisecond(),
        PAIR_COMMAND,
    )
    .unwrap();
    let untagged =
        format!("restrict,expiry-time=\"20110101000000\" ecdsa-sha2-nistp256 {BLOB} owner\r\n");
    let before = fs::read_to_string(&path).unwrap();
    fs::write(&path, format!("{before}{untagged}")).unwrap();
    keys.add_pairing(&other_key(), fresh, future.as_millisecond(), PAIR_COMMAND)
        .unwrap();
    let before = fs::read_to_string(&path).unwrap();
    let live = before.lines().find(|line| line.ends_with(fresh)).unwrap();
    assert!(!before.contains(expired));
    assert_eq!(before, format!("{untagged}{live}\n"));
}

#[test]
fn preserves_untagged_bytes_and_lists_only_devices() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authorized_keys");
    let head = b"# statglass-mobile:698BEA\r\n\r\ncommand=\"echo statglass-mobile:698BEA \\\"quoted\\\"\" ssh-ed25519 AAAA owner statglass-mobile:698BEA\r\n";
    let tail = b"future-key AAAA statglass-mobile:698BEA \xff";
    let existing = [head.as_slice(), tail.as_slice()].concat();
    fs::write(&path, &existing).unwrap();
    let keys = AuthorizedKeys::at(path.clone());
    assert!(keys.list_devices().unwrap().is_empty());
    let tag = keys
        .add_device(
            &EcdsaP256Public(POINT),
            "Riley's iPhone 📱 ._- 12345678901234567890",
            COMMAND,
        )
        .unwrap();
    assert_eq!(tag, DeviceTag::parse("698BEA").unwrap());
    let result = fs::read(&path).unwrap();
    assert!(result.starts_with(head));
    assert!(result.ends_with(tail));
    assert_eq!(
        &result[head.len()..result.len() - tail.len()],
        format!("restrict,command=\"'/Applications/A \\\"quoted\\\" path/helper' restricted --device {tag}\" ecdsa-sha2-nistp256 {BLOB} statglass-mobile:{tag} Rileys iPhone  ._- 1234567890123\n").as_bytes()
    );
    assert_eq!(
        keys.add_device(
            &EcdsaP256Public(POINT),
            "Riley's iPhone 📱 ._- 12345678901234567890",
            COMMAND
        )
        .unwrap(),
        tag
    );
    assert_eq!(fs::read(&path).unwrap(), result);
    assert_eq!(
        keys.list_devices().unwrap(),
        [PairedDevice {
            tag,
            name: "Rileys iPhone  ._- 1234567890123".into(),
            fingerprint: "SHA256:SFMVDOrhOSBssOVH9hIcK/Z2XVf1oSVMjNCL8u2aICY".into(),
        }]
    );
    assert!(!keys.revoke(DeviceTag::parse("FFFFFF").unwrap()).unwrap());
    assert!(keys.revoke(tag).unwrap());
    assert_eq!(fs::read(path).unwrap(), existing);
}

#[test]
fn pairing_key_has_local_time_expiry_through_seconds_and_its_own_tag() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".ssh/authorized_keys");
    let keys = AuthorizedKeys::at(path.clone());
    assert!(keys.list_devices().unwrap().is_empty());
    assert!(!keys.remove_pairing(NONCE).unwrap());
    assert!(!path.parent().unwrap().exists());
    let timestamp: jiff::Timestamp = "2025-01-02T03:04:59.999+05:30".parse().unwrap();
    let expiry = timestamp.to_zoned(localtime()).strftime("%Y%m%d%H%M%S");
    let key = EcdsaP256Public(POINT);
    keys.add_pairing(&key, NONCE, timestamp.as_millisecond(), PAIR_COMMAND)
        .unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        format!(
            "restrict,expiry-time=\"{expiry}\",command=\"{PAIR_COMMAND}\" ecdsa-sha2-nistp256 {BLOB} statglass-pairing:{NONCE}\n"
        )
    );
    assert_eq!(mode(path.parent().unwrap()), 0o700);
    assert_eq!(mode(&path), 0o600);
    assert!(keys.list_devices().unwrap().is_empty());
    let tag = keys.add_device(&other_key(), "", COMMAND).unwrap();
    assert!(keys.remove_pairing(NONCE).unwrap());
    assert!(!keys.remove_pairing(NONCE).unwrap());
    assert_eq!(keys.list_devices().unwrap()[0].tag, tag);
}

#[test]
fn pairing_expiry_uses_localtime_despite_a_conflicting_process_tz() {
    let timestamp: jiff::Timestamp = "2025-01-02T03:04:59.999Z".parse().unwrap();
    if let Some(path) = std::env::var_os("STATGLASS_TEST_PAIRING_KEYS_PATH") {
        AuthorizedKeys::at(path.into())
            .add_pairing(
                &EcdsaP256Public(POINT),
                NONCE,
                timestamp.as_millisecond(),
                PAIR_COMMAND,
            )
            .unwrap();
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authorized_keys");
    let host_time = timestamp.to_zoned(localtime());
    let process_tz = if host_time.offset().seconds() == 0 {
        "America/New_York"
    } else {
        "UTC"
    };
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "pairing_expiry_uses_localtime_despite_a_conflicting_process_tz",
        ])
        .env("STATGLASS_TEST_PAIRING_KEYS_PATH", &path)
        .env("TZ", process_tz)
        .output()
        .unwrap();
    assert!(child.status.success(), "{child:?}");
    let expected = format!("expiry-time=\"{}\"", host_time.strftime("%Y%m%d%H%M%S"));
    let line = fs::read_to_string(path).unwrap();
    assert!(
        line.contains(&expected),
        "{line:?} does not contain {expected:?}"
    );
}

#[test]
fn rejects_a_key_already_authorized_outside_its_managed_line() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authorized_keys");
    let original = format!("from=\"127.0.0.1\" ecdsa-sha2-nistp256 {BLOB} existing-access\n");
    fs::write(&path, &original).unwrap();
    let keys = AuthorizedKeys::at(path.clone());
    let key = EcdsaP256Public(POINT);
    assert!(keys.add_device(&key, "Phone", COMMAND).is_err());
    assert!(
        keys.add_pairing(&key, NONCE, 1_577_836_800_000, PAIR_COMMAND)
            .is_err()
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
}

#[test]
fn rejects_off_curve_p256_points_without_writing_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authorized_keys");
    let keys = AuthorizedKeys::at(path.clone());
    let mut point = [0; 65];
    point[0] = 4;
    let invalid = EcdsaP256Public(point);
    assert!(keys.add_device(&invalid, "Phone", COMMAND).is_err());
    assert!(
        keys.add_pairing(&invalid, NONCE, 1_577_836_800_000, PAIR_COMMAND)
            .is_err()
    );
    assert!(!path.exists());
}

#[test]
fn errors_name_the_operation_and_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authorized_keys");
    fs::create_dir(&path).unwrap();
    let keys = AuthorizedKeys::at(path.clone());
    let error = keys.list_devices().unwrap_err().to_string();
    assert!(
        error.contains("reading") && error.contains(path.to_str().unwrap()),
        "{error}"
    );
}

#[test]
fn follows_relative_links_and_updates_modes_without_changing_other_directories() {
    let dir = tempfile::tempdir().unwrap();
    let ssh = dir.path().join(".ssh");
    let dotfiles = dir.path().join("dotfiles");
    fs::create_dir(&ssh).unwrap();
    fs::create_dir(&dotfiles).unwrap();
    fs::set_permissions(&ssh, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&dotfiles, fs::Permissions::from_mode(0o750)).unwrap();
    let target = dotfiles.join("keys");
    let link = ssh.join("authorized_keys");
    symlink("../dotfiles/hop", &link).unwrap();
    symlink("keys", dotfiles.join("hop")).unwrap();
    let keys = AuthorizedKeys::at(link.clone());
    let tag = keys
        .add_device(&EcdsaP256Public(POINT), "Phone", COMMAND)
        .unwrap();
    assert_eq!(fs::read_link(&link).unwrap(), Path::new("../dotfiles/hop"));
    assert_eq!(
        fs::read_link(dotfiles.join("hop")).unwrap(),
        Path::new("keys")
    );
    assert_eq!(keys.list_devices().unwrap()[0].tag, tag);
    assert_eq!(mode(&target), 0o600);
    assert_eq!(mode(&ssh), 0o700);
    assert_eq!(mode(&dotfiles), 0o750);
    assert!(dotfiles.join(".statglass.lock").is_file());
    assert!(keys.revoke(tag).unwrap());
    assert_eq!(fs::read(&target).unwrap(), b"");
}

#[test]
fn rejects_line_breaks_without_creating_a_key_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authorized_keys");
    let keys = AuthorizedKeys::at(path.clone());
    let key = EcdsaP256Public(POINT);
    assert!(keys.add_device(&key, "Phone", "invalid\ncommand").is_err());
    assert!(
        keys.add_pairing(&key, "invalid\nnonce", 0, PAIR_COMMAND)
            .is_err()
    );
    assert!(!path.exists());
}
