use statglass_remote::AGENT_COMMAND_NOT_ALLOWED;
use std::process::{Command, Stdio};

const NONCE: &str = "1cdd0c2c3aa881dad8a557c28b983f0a";

fn agent() -> Command {
    let mut agent = Command::new(env!("CARGO_BIN_EXE_statglass-agent"));
    agent
        .env_remove("XDG_RUNTIME_DIR")
        .env_remove("SSH_ORIGINAL_COMMAND");
    agent
}

#[test]
fn pair_forced_refuses_invalid_nonce_and_non_pair_ssh_commands() {
    let invalid = agent()
        .args(["pair", "--nonce", "../../metrics"])
        .output()
        .unwrap();
    assert_eq!(invalid.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("invalid pairing nonce"));
    for original in ["serve", "pair;id", "pair ", ""] {
        let output = agent()
            .env("SSH_ORIGINAL_COMMAND", original)
            .args(["pair", "--nonce", NONCE])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert_eq!(
            output.stderr,
            format!("{AGENT_COMMAND_NOT_ALLOWED}\n").as_bytes()
        );
    }
}

#[test]
fn pair_forced_handles_empty_stdin_with_inherited_or_missing_home() {
    let dir = tempfile::tempdir().unwrap();
    let empty = agent()
        .env("HOME", dir.path())
        .args(["pair", "--nonce", NONCE])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(empty.status.code(), Some(2));
    assert!(empty.stdout.is_empty());
    assert!(!dir.path().join(".local/state/statglass").exists());

    let missing = agent()
        .env_remove("HOME")
        .args(["pair", "--nonce", NONCE])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(2));
    assert!(missing.stdout.is_empty() && missing.stderr.is_empty());
}
