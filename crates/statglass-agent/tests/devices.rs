use std::{
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
