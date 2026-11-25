#![cfg_attr(test, allow(clippy::too_many_lines))]
//! Only bridges authenticated local sockets; it never starts a collector or opens SQLite.
use statglass_remote::{ControlRequest, SocketPaths, control_request, stdio_bridge};

mod markers;
mod pair;
mod restricted;

fn main() {
    if let Some(code) = forced_command(&std::env::args().skip(1).collect::<Vec<_>>()) {
        std::process::exit(code);
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("statglass-remote-helper: {error}");
            std::process::exit(1);
        }
    };
    let result = runtime.block_on(run());
    // Without waiting on blocking tasks: `serve`'s stdin reader stays blocked in read(2)
    // after the app closes the session, and dropping the runtime would wait for it and
    // keep the bridge (and the SSH session) alive.
    runtime.shutdown_background();
    if let Err(error) = result {
        eprintln!("statglass-remote-helper: {error}");
        std::process::exit(1);
    }
}
/// The forced commands an `authorized_keys` line runs (`restricted --device <tag>` and
/// `pair --nonce <n>`); each returns its own exit code. `None` for every other command.
fn forced_command(args: &[String]) -> Option<i32> {
    match args {
        [mode, flag, device] if mode == "restricted" && flag == "--device" => {
            Some(restricted::run(device))
        }
        [mode, flag, nonce] if mode == "pair" && flag == "--nonce" => Some(pair::run(nonce)),
        _ => None,
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("version") {
        println!(
            "{}",
            serde_json::to_string(&statglass_remote::control::HelperVersion::current())?
        );
        return Ok(());
    }
    let paths = SocketPaths::for_current_user()?;
    match args.first().map(String::as_str) {
        Some("serve") if args.get(1).map(String::as_str) == Some("--stdio") => {
            stdio_bridge(&paths.metrics).await?;
        }
        Some("status") => {
            println!(
                "{}",
                serde_json::to_string(
                    &control_request(&paths.control, &ControlRequest::Status).await?
                )?
            );
        }
        Some("update-status") => {
            println!(
                "{}",
                serde_json::to_string(
                    &control_request(&paths.control, &ControlRequest::UpdateStatus).await?
                )?
            );
        }
        Some("configure") => {
            let request: ControlRequest =
                serde_json::from_str(args.get(1).ok_or("configure requires a JSON request")?)?;
            if !matches!(
                request,
                ControlRequest::Configure { .. } | ControlRequest::UpdatePolicy { .. }
            ) {
                return Err("configure requires configuration request".into());
            }
            println!(
                "{}",
                serde_json::to_string(&control_request(&paths.control, &request).await?)?
            );
        }
        _ => {
            return Err(
                "usage: statglass-remote-helper serve --stdio | version --json | status | update-status --json | configure '<json>' | restricted --device <tag> | pair --nonce <n>".into(),
            );
        }
    }
    Ok(())
}
