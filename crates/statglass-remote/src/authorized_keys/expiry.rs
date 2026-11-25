use super::{DeviceKeysError, key_io};
use jiff::{Timestamp, tz::TimeZone};
use std::{fs, io, path::Path};

pub(super) fn format(expires_ms: i64) -> Result<String, DeviceKeysError> {
    let expiry = Timestamp::from_millisecond(expires_ms)
        .map_err(|error| DeviceKeysError::Invalid(format!("invalid pairing expiry: {error}")))?
        .to_zoned(host_zone()?);
    if expiry.year() < 1970 {
        return Err(DeviceKeysError::Invalid(
            "pairing expiry predates 1970".into(),
        ));
    }
    Ok(expiry.strftime("%Y%m%d%H%M%S").to_string())
}

fn host_zone() -> Result<TimeZone, DeviceKeysError> {
    let localtime = Path::new("/etc/localtime");
    // sshd uses the host zone for unsuffixed times. The pairing process may
    // inherit a different TZ from the user's shell.
    let zone = match fs::read(localtime) {
        Ok(bytes) => TimeZone::tzif("localtime", &bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => TimeZone::try_system(),
        Err(error) => return key_io(Err(error), "reading", localtime),
    };
    zone.map_err(|error| {
        DeviceKeysError::Invalid(format!("could not identify the host's time zone: {error}"))
    })
}
