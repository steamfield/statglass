//! The helper as the one-time pairing key's forced command (`pair --nonce <n>`, RFC
//! `plan/rfc-ios-app.md` 2.4): relays the phone's `PairStart` to the app's control socket
//! through the shared pairing relay.
use statglass_remote::{SocketPaths, pairing::run_forced_for_nonce};

/// Runs the pairing exchange for the nonce on the forced command line.
pub fn run(nonce: &str) -> i32 {
    if std::env::var_os("SSH_ORIGINAL_COMMAND").is_some_and(|command| command != "pair") {
        eprintln!("statglass-remote-helper: command not allowed");
        return 2;
    }
    let result = (|| {
        let paths = SocketPaths::for_current_user()?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let status = runtime.block_on(run_forced_for_nonce(
            tokio::io::stdin(),
            tokio::io::stdout(),
            &paths.control,
            nonce,
        ));
        runtime.shutdown_background();
        Ok::<_, statglass_remote::RemoteError>(status)
    })();
    result.unwrap_or_else(|error| {
        eprintln!("statglass-remote-helper: {error}");
        2
    })
}
