use std::process::{Command, Output};

use statglass_remote::{EcdsaP256Public, HELPER_COMMAND_NOT_ALLOWED};

fn helper(args: &[&str], original: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_statglass-remote-helper"));
    command.args(args).env_remove("SSH_ORIGINAL_COMMAND");
    if let Some(original) = original {
        command.env("SSH_ORIGINAL_COMMAND", original);
    }
    command.output().expect("run the remote helper")
}

#[test]
fn rejects_invalid_base64_off_curve_points_and_invalid_tags() {
    let mut point = [0; 65];
    point[0] = 4;
    let off_curve = EcdsaP256Public(point).to_base64();
    for key in ["!not-base64", "BGsX", &off_curve] {
        let output = helper(&["authorize-key", "--key", key, "--name", "Phone"], None);
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("uncompressed P-256 public key"));
    }
    let result = helper(&["revoke-key", "--device", "xxxxxx"], None);
    assert_eq!(result.status.code(), Some(2));
    assert!(result.stdout.is_empty());
    assert!(String::from_utf8_lossy(&result.stderr).contains("uppercase hex device tag"));
}

#[test]
fn restricted_ssh_rejects_handover_commands() {
    for command in [
        "authorize-key --key bogus --name Phone",
        "revoke-key --device 7F3A2C",
    ] {
        let result = helper(&["restricted", "--device", "7F3A2C"], Some(command));
        assert_eq!(result.status.code(), Some(2));
        assert!(result.stdout.is_empty());
        assert_eq!(
            result.stderr,
            format!("{HELPER_COMMAND_NOT_ALLOWED}\n").as_bytes()
        );
    }
}
