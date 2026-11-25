use super::{DeviceKeysError, PAIRING, entry, key_io};
use jiff::{Timestamp, civil::DateTime, tz::TimeZone};
use std::{fs, io, path::Path};

const FORMAT: &str = "%Y%m%d%H%M%S";

pub(super) struct PairingExpiry {
    now: Timestamp,
    zone: TimeZone,
}

impl PairingExpiry {
    pub(super) fn new() -> Result<Self, DeviceKeysError> {
        Ok(Self {
            now: Timestamp::now(),
            zone: host_zone()?,
        })
    }

    pub(super) fn format(&self, expires_ms: i64) -> Result<String, DeviceKeysError> {
        let expiry = Timestamp::from_millisecond(expires_ms)
            .map_err(|error| DeviceKeysError::Invalid(format!("invalid pairing expiry: {error}")))?
            .to_zoned(self.zone.clone());
        if expiry.year() < 1970 {
            return Err(DeviceKeysError::Invalid(
                "pairing expiry predates 1970".into(),
            ));
        }
        Ok(expiry.strftime(FORMAT).to_string())
    }

    pub(super) fn prune(&self, current: &[u8]) -> Vec<u8> {
        current
            .split_inclusive(|&byte| byte == b'\n')
            .filter(|line| !self.expired(line))
            .flatten()
            .copied()
            .collect()
    }

    fn expired(&self, line: &[u8]) -> bool {
        let Some(date) = line
            .trim_ascii_start()
            .strip_prefix(b"restrict,expiry-time=\"")
            .and_then(|rest| rest.splitn(2, |&byte| byte == b'"').next())
            .filter(|date| date.len() == 14 && date.iter().all(u8::is_ascii_digit))
        else {
            return false;
        };
        if !entry(line).is_some_and(|entry| entry.token.starts_with(PAIRING.as_bytes())) {
            return false;
        }
        let Ok(date) = DateTime::strptime(FORMAT, date) else {
            return false;
        };
        // An unsuffixed time can occur twice when clocks move back. Keep the line
        // until both interpretations are past; the relay checks the true instant.
        self.zone
            .to_ambiguous_timestamp(date)
            .later()
            .is_ok_and(|expiry| expiry <= self.now)
    }
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
