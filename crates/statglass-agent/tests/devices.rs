use statglass_remote::{
    AgentEnv, AgentLayout, AuthorizedKeys, DeviceKeys, DeviceSeenLog, DeviceTag, EcdsaP256Public,
};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn agent(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_statglass-agent"))
        .env("HOME", home)
        .env("XDG_STATE_HOME", home.join("state"))
        .args(args)
        .output()
        .expect("run the agent")
}

#[test]
fn empty_list_and_unknown_revoke_leave_a_missing_ssh_directory_alone() {
    let home = tempfile::tempdir().unwrap();
    let list = agent(home.path(), &["devices"]);
    assert!(list.status.success());
    assert!(list.stdout.is_empty() && list.stderr.is_empty());
    let revoke = agent(home.path(), &["devices", "revoke", "7F3A2C"]);
    assert_eq!(revoke.status.code(), Some(1));
    assert!(revoke.stdout.is_empty() && revoke.stderr.is_empty());
    assert!(!home.path().join(".ssh").exists());
}

#[test]
fn lists_the_key_fingerprint_and_revokes_only_the_selected_device() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join(".ssh/authorized_keys");
    let keys = AuthorizedKeys::at(path.clone());
    let layout = AgentLayout::for_uid(rustix::process::geteuid().as_raw());
    // A system-layout CLI deliberately uses system state. Keep the fixture isolated
    // even when the test runner is root.
    let seen = if layout == AgentLayout::User {
        let env = AgentEnv {
            home: Some(home.path().to_path_buf()),
            ..Default::default()
        };
        let paths = layout.paths(&env).unwrap();
        fs::create_dir_all(&paths.data_dir).unwrap();
        Some(DeviceSeenLog::new(paths.data_dir.join("device-seen.jsonl")))
    } else {
        None
    };
    // Both points are the P-256 generator and its negation.
    let mut a = [
        4, 107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125,
        129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150, 79, 227, 66, 226, 254, 26,
        127, 155, 142, 231, 235, 74, 124, 15, 158, 22, 43, 206, 51, 87, 107, 49, 94, 206, 203, 182,
        64, 104, 55, 191, 81, 245,
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
        176, 28, 189, 28, 1, 229, 128, 101, 113, 24, 20, 181, 131, 240, 97, 233, 212, 49, 204, 169,
        148, 206, 161, 49, 52, 73, 191, 151, 200, 64, 174, 10,
    ]);
    let other = add(a, "Tablet");
    if let Some(seen) = &seen {
        seen.record(first, 123456);
    }
    let list = agent(home.path(), &["devices"]);
    assert!(list.status.success(), "{:?}", list.stderr);
    assert!(list.stderr.is_empty());
    let rows = keys.list_devices().unwrap();
    let expected = format!(
        "{first}\tPhone\t{}\t{}\n{other}\tTablet\t{}\tnever\n",
        rows[0].fingerprint,
        if seen.is_some() { "123456" } else { "never" },
        rows[1].fingerprint,
    );
    assert_eq!(list.stdout, expected.as_bytes());
    let revoke = agent(home.path(), &["devices", "revoke", &first.to_string()]);
    assert!(revoke.status.success());
    assert!(revoke.stdout.is_empty() && revoke.stderr.is_empty());
    assert_eq!(keys.list_devices().unwrap(), [rows[1].clone()]);
}

#[test]
fn malformed_devices_invocations_fail_at_the_cli() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        &["devices", "revoke"][..],
        &["devices", "revoke", "7f3a2c"][..],
        &["devices", "list", "extra"][..],
        &["devices", "--system"][..],
    ] {
        let result = agent(home.path(), args);
        assert_eq!(result.status.code(), Some(1), "{args:?}");
        assert!(result.stdout.is_empty());
        assert!(!result.stderr.is_empty());
    }
    assert!(!home.path().join(".ssh").exists());
}
