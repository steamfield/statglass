use serde_json::Value;
use statglass_engine::ProcessView;
use statglass_ipc::error::CommandError;
use statglass_schema::HostId;

use super::{invalid, registry::Registry};

pub(super) fn set_interest(
    registry: &Registry,
    host: HostId,
    interested: bool,
    view: Option<ProcessView>,
    stream: Option<u32>,
) -> Result<Value, CommandError> {
    let Some(stream) = stream else {
        return if interested {
            Err(invalid("process interest requires a live stream"))
        } else {
            Ok(Value::Null)
        };
    };
    // Closing the stream or removing the host already dropped its interest.
    let entry = match registry.entry(host) {
        Ok(entry) => entry.running()?,
        Err(CommandError::UnknownHost { .. }) if !interested => return Ok(Value::Null),
        Err(error) => return Err(error),
    };
    registry.live.set_process_interest(
        entry,
        stream,
        interested.then(|| view.unwrap_or_default()),
    )?;
    Ok(Value::Null)
}
