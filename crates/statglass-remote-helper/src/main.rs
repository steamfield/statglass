#![cfg_attr(test, allow(clippy::too_many_lines))]
//! Only bridges authenticated local sockets; it never starts a collector or opens SQLite.
use statglass_remote::{ControlRequest, SessionScope, SocketPaths, control_request};

mod markers;
mod pair;
mod restricted;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [mode, flag, nonce] = args.as_slice()
        && mode == "pair"
        && flag == "--nonce"
    {
        std::process::exit(pair::run(nonce));
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
    let result = runtime.block_on(run(&args));
    // Without waiting on blocking tasks: `serve`'s stdin reader stays blocked in read(2)
    // after the app closes the session, and dropping the runtime would wait for it and
    // keep the bridge (and the SSH session) alive.
    runtime.shutdown_background();
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("statglass-remote-helper: {error}");
            std::process::exit(1);
        }
    }
}
type CommandResult = Result<i32, Box<dyn std::error::Error>>;

async fn run(args: &[String]) -> CommandResult {
    if let [mode, flag, device] = args
        && mode == "restricted"
        && flag == "--device"
    {
        return restricted::run(device).await;
    }
    if args.first().map(String::as_str) == Some("--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(0);
    }
    if args.first().map(String::as_str) == Some("version") {
        return print_version();
    }
    let paths = SocketPaths::for_current_user()?;
    match args.first().map(String::as_str) {
        Some("serve") if args.get(1).map(String::as_str) == Some("--stdio") => {
            return Ok(markers::serve_or_marker(&paths, SessionScope::Full).await?);
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
    Ok(0)
}

fn print_version() -> CommandResult {
    println!(
        "{}",
        serde_json::to_string(&statglass_remote::control::HelperVersion::current())?
    );
    Ok(0)
}
