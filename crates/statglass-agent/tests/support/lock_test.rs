/// Run lock-sensitive tests without sibling tests forking while the lock is
/// held: even CLOEXEC descriptors survive in a child between fork and exec.
/// These re-execs are themselves forks, so every test that can take the
/// installation or history lock must call this, not just the ones near a spawn.
/// Returns true once the parent has verified the child, false inside that child.
pub(crate) fn reexec_for_lock_test() -> bool {
    let thread = std::thread::current();
    let name = thread.name().expect("libtest must name the test thread");
    const CHILD: &str = "STATGLASS_TEST_LOCK_CHILD";
    if std::env::var_os(CHILD).as_deref() == Some(std::ffi::OsStr::new(name)) {
        return false;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture"])
        .env(CHILD, name)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success() && stdout.contains("test result: ok. 1 passed; 0 failed;"),
        "isolated test {name} did not pass ({})\nstdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    // libtest captures these unless --nocapture, matching an inline run.
    print!("{stdout}");
    eprint!("{stderr}");
    true
}
