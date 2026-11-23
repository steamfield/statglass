//! Runs one request through the system's curl and classifies the result. The only module
//! in the crate that spawns a process.
//!
//! The whole request, URL and headers included, goes to curl as a config on stdin
//! (`curl -q -K -`), so no token or webhook URL appears in the process list. Every config
//! value is double-quoted with backslash, quote, newline, carriage return and tab
//! escaped; a value holding any other control character is refused before curl runs.
//! Only http and https are allowed, redirects are not followed, and curl's exit code
//! names transport failures while the status code decides the rest
//! (plan/rfc-alerts.md 6.4).

use std::path::Path;

use statglass_schema::{DeliveryFailure, DeliveryOutcome};

use crate::request::HttpRequest;

/// The curl config for `request`: `url`, `request = "POST"`, one `header` line per
/// header and a `data` line, each value quoted and escaped. `Err` names the field that
/// holds a control character other than newline, carriage return or tab ("url",
/// "header", "body"), never its value.
pub fn config_text(request: &HttpRequest) -> Result<String, String> {
    let _ = request;
    Ok(String::new())
}

/// curl's command-line arguments: `-q` first, then `--proto =http,https`,
/// `--max-redirs 0`, `--max-time <timeout_secs>`, `--silent --show-error`,
/// `--output /dev/null`, `--write-out %{http_code}` and `-K -`. Never the URL, a header
/// or the body, which travel on stdin.
pub fn arguments(timeout_secs: u32) -> Vec<String> {
    let _ = timeout_secs;
    Vec::new()
}

/// Sends `request` once through the curl at `curl` and classifies the result: a 2xx
/// status is `Delivered`, any other status `Failed { Http, "HTTP <code>" }`; exit 6
/// `NameNotFound`, 7 `ConnectFailed`, 28 `TimedOut`, 35 and 60 `Tls`; a missing binary
/// `CurlMissing`; a control character in the request `Rejected` without spawning;
/// anything else `Other` with curl's first stderr line. Blocking.
pub fn run(curl: &Path, request: &HttpRequest, timeout_secs: u32) -> DeliveryOutcome {
    let _ = (curl, request, timeout_secs);
    not_implemented()
}

/// The placeholder outcome of the scaffold's stubs.
pub(crate) fn not_implemented() -> DeliveryOutcome {
    DeliveryOutcome::Failed {
        reason: DeliveryFailure::Other,
        detail: "not implemented".into(),
    }
}
