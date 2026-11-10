use super::*;
use std::{os::unix::fs::symlink, process::Stdio, time::Duration};

fn json(command: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "user": "alice", "hostname": "client", "started": "2026-11-10T12:00:00Z",
        "command": command, "pid": 123, "machine_token": "secret", "job_pgid": 456,
        "unknown": { "anything": true }
    }))
    .unwrap()
}

#[test]
fn parse_allowlists_privacy_truncation_and_invalid_inputs() {
    let bytes = json(&"🦀".repeat(230));
    let job = parse(&bytes, "alice").unwrap();
    assert_eq!(job.command.as_ref().unwrap().chars().count(), 200);
    assert_eq!(job.client_hostname, "client");
    assert_eq!(job.started_ms, 1_794_312_000_000);
    let value = serde_json::to_value(&job).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 5);
    for field in ["pid", "machine_token", "job_pgid", "unknown"] {
        assert!(value.get(field).is_none());
    }
    assert!(parse(&bytes, "bob").is_none());
    assert!(parse(b"{broken", "alice").is_none());
    assert!(parse(&json(&"x".repeat(5000))[..4096], "alice").is_none());
    assert!(
        parse(
            br#"{"user":"alice","hostname":"client","started":"bad"}"#,
            "alice"
        )
        .is_none()
    );
    assert!(
        parse(
            br#"{"user":"alice","hostname":"client","started":"2026-11-10T12:00:00Z"}"#,
            "alice"
        )
        .unwrap()
        .command
        .is_none()
    );
}

fn started(value: &str) -> Option<i64> {
    let lock = format!(r#"{{"user":"riley","hostname":"mac","started":"{value}"}}"#);
    parse(lock.as_bytes(), "riley").map(|job| job.started_ms)
}

#[test]
fn timestamps_validate_calendar_offsets_and_fractional_seconds() {
    let base = started("2026-11-10T12:00:00Z").unwrap();
    assert_eq!(
        started("2026-11-10T14:30:00.123456+02:30"),
        Some(base + 123)
    );
    assert_eq!(started("2026-11-10t07:00:00.1-05:00"), Some(base + 100));
    for bad in [
        "2026-02-30T12:00:00Z",
        "2026-11-10T24:00:00Z",
        "2026-11-10T12:00:00.Z",
        "2026-11-10T12:00:00Zextra",
        "2026-11-10T12:00:00",
    ] {
        assert_eq!(started(bad), None, "{bad}");
    }
}

#[test]
fn peers_match_client_user_and_ten_second_window() {
    let job = parse(&json("cargo test"), "alice").unwrap();
    let ids: Vec<_> = (1..=5).map(|n| HostId(uuid::Uuid::from_u128(n))).collect();
    let mut jobs: BTreeMap<_, _> = ids.iter().map(|id| (*id, job.clone())).collect();
    jobs.get_mut(&ids[1]).unwrap().started_ms += 3000;
    jobs.get_mut(&ids[2]).unwrap().started_ms += 30_000;
    jobs.get_mut(&ids[3]).unwrap().user = "bob".into();
    jobs.get_mut(&ids[4]).unwrap().client_hostname = "other".into();
    group(&mut jobs);
    assert_eq!(jobs[&ids[0]].peers, vec![ids[1]]);
    assert_eq!(jobs[&ids[1]].peers, vec![ids[0]]);
    for id in &ids[2..] {
        assert!(jobs[id].peers.is_empty());
    }
    jobs.remove(&ids[1]);
    group(&mut jobs);
    assert!(jobs[&ids[0]].peers.is_empty());
}

#[test]
fn exact_remote_command_is_constant_and_runs_posix_sh() {
    assert_eq!(
        crate::transport::sh_c(SCRIPT).unwrap(),
        "exec /bin/sh -c 'if [ ! -L /tmp/rr.lock ] && [ -O /tmp/rr.lock ] && [ -O /tmp/rr.lock/info.json ] && [ -f /tmp/rr.lock/info.json ] && [ ! -L /tmp/rr.lock/info.json ]; then head -c 4096 /tmp/rr.lock/info.json; fi'"
    );
}

async fn script(dir: &std::path::Path) -> Vec<u8> {
    let command = SCRIPT.replace(LOCK_DIR, dir.to_str().unwrap());
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("sh")
            .args(["-c", &command])
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("FIFO must return promptly")
    .unwrap();
    assert!(output.status.success());
    output.stdout
}

#[tokio::test]
async fn remote_and_local_readers_reject_links_fifos_and_bound_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("lock");
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("info.json");
    let bytes = json("cargo test");
    std::fs::write(&file, &bytes).unwrap();
    assert_eq!(script(&dir).await, bytes);
    assert_eq!(local::read_at(&dir, "alice"), parse(&bytes, "alice"));
    assert!(local::read_at(&dir, "bob").is_none());
    let link = temp.path().join("link");
    symlink(&dir, &link).unwrap();
    assert!(script(&link).await.is_empty());
    assert!(local::read_at(&link, "alice").is_none());
    let target = temp.path().join("target");
    std::fs::rename(&file, &target).unwrap();
    symlink(&target, &file).unwrap();
    assert!(script(&dir).await.is_empty());
    assert!(local::read_at(&dir, "alice").is_none());
    std::fs::remove_file(&file).unwrap();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&file)
            .status()
            .unwrap()
            .success()
    );
    assert!(script(&dir).await.is_empty());
    let local_dir = dir.clone();
    assert!(
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || local::read_at(&local_dir, "alice"))
        )
        .await
        .expect("local FIFO must return promptly")
        .unwrap()
        .is_none()
    );
    std::fs::remove_file(&file).unwrap();
    std::fs::write(&file, json(&"x".repeat(5000))).unwrap();
    assert_eq!(script(&dir).await.len(), 4096);
    assert!(local::read_at(&dir, "alice").is_none());
    assert!(parse(&script(&dir).await, "alice").is_none());
}

#[test]
fn local_reader_requires_both_opened_objects_to_belong_to_the_login() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("info.json"), json("cargo test")).unwrap();
    for foreign in [0, 1] {
        let calls = std::cell::Cell::new(0);
        let bytes = local::read_owned(temp.path(), |_| {
            let index = calls.get();
            calls.set(index + 1);
            index != foreign
        })
        .unwrap();
        assert!(
            bytes.is_none(),
            "foreign opened object {foreign} must be rejected"
        );
    }
}

#[test]
fn ssh_login_parses_config_and_rejects_a_missing_or_empty_user() {
    assert_eq!(
        parse_login("host builder\nuser alice\nhostname 192.0.2.1\n").unwrap(),
        "alice"
    );
    for config in [
        "host builder\nhostname 192.0.2.1\n",
        "user \nhost builder\n",
    ] {
        assert!(matches!(
            parse_login(config),
            Err(crate::RemoteError::Protocol(_))
        ));
    }
}

#[test]
fn remote_script_has_string_guards_for_directory_and_file_ownership() {
    assert!(SCRIPT.contains("[ -O /tmp/rr.lock ] && [ -O /tmp/rr.lock/info.json ]"));
}
