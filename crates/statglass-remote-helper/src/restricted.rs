//! The helper as a restricted key's forced command (`restricted --device <tag>`, RFC
//! `plan/rfc-ios-app.md` 2.3): compares `SSH_ORIGINAL_COMMAND` exactly against `serve`,
//! `version` and `status`, and refuses anything else with exit 2.
use statglass_remote::{
    ControlRequest, DeviceTag, SessionScope, SocketPaths, control_request, scope::RestrictedCommand,
};

/// Runs the forced command for `device` and returns the process exit code.
pub async fn run(device: &str) -> crate::CommandResult {
    let Some(device) = DeviceTag::parse(device) else {
        eprintln!("statglass-remote-helper: invalid device tag");
        return Ok(2);
    };
    let original = std::env::var_os("SSH_ORIGINAL_COMMAND");
    let Some(command) = RestrictedCommand::parse(original.as_deref()) else {
        eprintln!("statglass-remote-helper: command not allowed");
        return Ok(2);
    };
    match command {
        RestrictedCommand::Serve => Ok(crate::markers::serve_or_marker(
            &SocketPaths::for_current_user()?,
            SessionScope::Restricted { device },
        )
        .await?),
        RestrictedCommand::Version => crate::print_version(),
        RestrictedCommand::Status => {
            let response = match SocketPaths::for_current_user() {
                Ok(paths) => control_request(&paths.control, &ControlRequest::Status).await,
                Err(error) => Err(error),
            };
            let status = match response {
                Ok(response) => serde_json::to_value(response)?,
                Err(error) => serde_json::json!({"ok": false, "message": error.to_string()}),
            };
            println!("{status}");
            Ok(0)
        }
    }
}
