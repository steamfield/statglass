//! Runs one request through the system's curl and classifies the result. The only module
//! in the crate that spawns a process.
//!
//! The whole request, URL and headers included, goes to curl as a config on stdin
//! (`curl -q -K -`), so no token or webhook URL appears in the process list. Every config
//! value is double-quoted with backslash, quote, newline, carriage return and tab
//! escaped. The body may hold newlines, carriage returns and tabs; any other control
//! character, and any control character at all in the URL or a header, is refused before
//! curl runs. Only http and https are allowed, redirects are not followed, and curl's
//! exit code names transport failures while the status code decides the rest
//! (plan/rfc-alerts.md 6.4).

use std::io::{self, Write};
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};

use statglass_schema::{DeliveryFailure, DeliveryOutcome};

use crate::request::HttpRequest;

/// curl's exit code when the host name did not resolve.
const EXIT_COULDNT_RESOLVE_HOST: i32 = 6;
/// curl's exit code when the connection was refused or unreachable.
const EXIT_COULDNT_CONNECT: i32 = 7;
/// curl's exit code when `--max-time` ran out.
const EXIT_OPERATION_TIMEDOUT: i32 = 28;
/// curl's exit code for a failed TLS handshake.
const EXIT_SSL_CONNECT_ERROR: i32 = 35;
/// curl's exit code for a certificate that failed verification.
const EXIT_PEER_FAILED_VERIFICATION: i32 = 60;

/// How a failed HTTP status reads in a `Failed { Http }` detail ("HTTP 403").
const HTTP_DETAIL_PREFIX: &str = "HTTP ";

/// The curl config for `request`: `url`, `request = "POST"`, one `header` line per
/// header and a `data-raw` line, each value quoted and escaped. `Err` names the field
/// that holds a refused control character ("url", "header", "body"), never its value.
pub fn config_text(request: &HttpRequest) -> Result<String, String> {
    if request.url.contains(char::is_control) {
        return Err(refused("url"));
    }
    let header_has_control = request
        .headers
        .iter()
        .any(|(name, value)| name.contains(char::is_control) || value.contains(char::is_control));
    if header_has_control {
        return Err(refused("header"));
    }
    let body_has_control = request
        .body
        .contains(|c: char| c.is_control() && !matches!(c, '\n' | '\r' | '\t'));
    if body_has_control {
        return Err(refused("body"));
    }
    let mut config = format!("url = {}\nrequest = \"POST\"\n", quoted(&request.url));
    for (name, value) in &request.headers {
        config.push_str(&format!(
            "header = {}\n",
            quoted(&format!("{name}: {value}"))
        ));
    }
    // `data-raw`, not `data`: a body starting with "@" must be sent, not read as a file.
    config.push_str(&format!("data-raw = {}\n", quoted(&request.body)));
    Ok(config)
}

/// The refusal text for a field holding a control character.
fn refused(field: &str) -> String {
    format!("the {field} holds a control character")
}

/// `value` as a double-quoted curl config value. Inside quotes curl reads `\\`, `\"`,
/// `\n`, `\r` and `\t` as escapes, so no value can close the quote or start a new line.
fn quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// curl's command-line arguments: `-q` first, then `--proto =http,https`,
/// `--max-redirs 0`, `--max-time <timeout_secs>`, `--silent --show-error`,
/// `--output /dev/null`, `--write-out %{http_code}` and `-K -`. Never the URL, a header
/// or the body, which travel on stdin.
pub fn arguments(timeout_secs: u32) -> Vec<String> {
    // `-q` only works as the first argument; it keeps the user's ~/.curlrc out. There
    // is no `--fail`: the status code is read from `--write-out` and decides the outcome.
    [
        "-q",
        "--proto",
        "=http,https",
        "--max-redirs",
        "0",
        "--max-time",
        &timeout_secs.to_string(),
        "--silent",
        "--show-error",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        "-K",
        "-",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

/// Sends `request` once through the curl at `curl` and classifies the result: a 2xx
/// status is `Delivered`, any other status `Failed { Http, "HTTP <code>" }`; exit 6
/// `NameNotFound`, 7 `ConnectFailed`, 28 `TimedOut`, 35 and 60 `Tls`; a missing binary
/// `CurlMissing`; a refused control character in the request `Rejected` without
/// spawning; anything else `Other` with curl's first stderr line. Blocking.
pub fn run(curl: &Path, request: &HttpRequest, timeout_secs: u32) -> DeliveryOutcome {
    let config = match config_text(request) {
        Ok(config) => config,
        Err(reason) => return failed(DeliveryFailure::Rejected, format!("Not sent: {reason}")),
    };
    let child = match spawn(curl, timeout_secs) {
        Ok(child) => child,
        Err(outcome) => return outcome,
    };
    match finish(child, &config) {
        Ok(output) => classify(&output, &request.url, timeout_secs),
        Err(error) => failed(
            DeliveryFailure::Other,
            format!("Could not pass the request to curl: {error}"),
        ),
    }
}

/// Starts curl with every stream piped, or the outcome that explains why it did not start.
fn spawn(curl: &Path, timeout_secs: u32) -> Result<Child, DeliveryOutcome> {
    Command::new(curl)
        .args(arguments(timeout_secs))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => failed(
                DeliveryFailure::CurlMissing,
                format!("curl is not installed at {}", curl.display()),
            ),
            _ => failed(
                DeliveryFailure::Other,
                format!("Could not run curl at {}: {error}", curl.display()),
            ),
        })
}

/// Writes the config to curl's stdin, closes it and waits for curl to exit. If the write
/// fails, curl is killed and reaped so no zombie is left, and the write error returned.
fn finish(mut child: Child, config: &str) -> io::Result<Output> {
    let written = match child.stdin.take() {
        Some(mut stdin) => stdin.write_all(config.as_bytes()),
        None => Err(io::Error::other("curl's stdin was not piped")),
    };
    if let Err(error) = written {
        // A kill can fail only because curl already exited; the wait reaps it either way.
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    child.wait_with_output()
}

/// The outcome of a finished curl run, from its exit code, the status code it wrote to
/// stdout and its stderr.
fn classify(output: &Output, url: &str, timeout_secs: u32) -> DeliveryOutcome {
    match output.status.code() {
        Some(0) => status_outcome(&String::from_utf8_lossy(&output.stdout)),
        Some(EXIT_COULDNT_RESOLVE_HOST) => failed(
            DeliveryFailure::NameNotFound,
            "Server name not found".into(),
        ),
        Some(EXIT_COULDNT_CONNECT) => {
            failed(DeliveryFailure::ConnectFailed, "Could not connect".into())
        }
        Some(EXIT_OPERATION_TIMEDOUT) => failed(
            DeliveryFailure::TimedOut,
            format!("Timed out after {timeout_secs} s"),
        ),
        Some(EXIT_SSL_CONNECT_ERROR | EXIT_PEER_FAILED_VERIFICATION) => {
            failed(DeliveryFailure::Tls, "TLS error".into())
        }
        Some(code) => failed(
            DeliveryFailure::Other,
            curl_message(&output.stderr, url)
                .unwrap_or_else(|| format!("curl exited with code {code}")),
        ),
        None => failed(
            DeliveryFailure::Other,
            "curl was stopped before it finished".into(),
        ),
    }
}

/// The outcome of a run that reached the server: `Delivered` for 2xx, `Failed { Http }`
/// for any other status.
fn status_outcome(written: &str) -> DeliveryOutcome {
    let Ok(status) = written.trim().parse::<u16>() else {
        return failed(
            DeliveryFailure::Other,
            "curl reported no HTTP status".into(),
        );
    };
    if (200..300).contains(&status) {
        DeliveryOutcome::Delivered { status }
    } else {
        failed(
            DeliveryFailure::Http,
            format!("{HTTP_DETAIL_PREFIX}{status}"),
        )
    }
}

/// curl's first stderr line without its "curl: " prefix, with the URL and its host
/// replaced by "the server" so the detail never carries an address.
fn curl_message(stderr: &[u8], url: &str) -> Option<String> {
    let stderr = String::from_utf8_lossy(stderr);
    let line = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let line = line.strip_prefix("curl: ").unwrap_or(line);
    let mut message = line.replace(url, "the server");
    let host = url
        .split_once("://")
        .map_or(url, |(_, rest)| rest)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if !host.is_empty() {
        message = message.replace(host, "the server");
    }
    Some(message)
}

/// The status code of a `Failed { Http }` outcome, read back from its detail.
pub(crate) fn http_status(outcome: &DeliveryOutcome) -> Option<u16> {
    match outcome {
        DeliveryOutcome::Failed {
            reason: DeliveryFailure::Http,
            detail,
        } => detail.strip_prefix(HTTP_DETAIL_PREFIX)?.parse().ok(),
        _ => None,
    }
}

/// A `Failed` outcome.
fn failed(reason: DeliveryFailure, detail: String) -> DeliveryOutcome {
    DeliveryOutcome::Failed { reason, detail }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str, headers: &[(&str, &str)], body: &str) -> HttpRequest {
        HttpRequest {
            url: url.into(),
            headers: headers
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect(),
            body: body.into(),
        }
    }

    #[test]
    fn config_has_one_quoted_line_per_field() {
        let config = config_text(&request(
            "https://ntfy.sh/",
            &[
                ("Content-Type", "application/json"),
                ("Authorization", "Bearer tk"),
            ],
            r#"{"a":1}"#,
        ))
        .unwrap();
        assert_eq!(
            config,
            "url = \"https://ntfy.sh/\"\nrequest = \"POST\"\n\
             header = \"Content-Type: application/json\"\n\
             header = \"Authorization: Bearer tk\"\n\
             data-raw = \"{\\\"a\\\":1}\"\n"
        );
    }

    #[test]
    fn quotes_backslashes_and_line_breaks_are_escaped_in_the_body() {
        let config =
            config_text(&request("http://127.0.0.1/", &[], "a \"b\" \\c\nd\re\tf\\")).unwrap();
        assert!(
            config.ends_with("data-raw = \"a \\\"b\\\" \\\\c\\nd\\re\\tf\\\\\"\n"),
            "{config}"
        );
        assert_eq!(config.lines().count(), 3, "{config}");
    }

    #[test]
    fn line_breaks_are_refused_in_the_url_and_headers() {
        let url = config_text(&request("http://127.0.0.1/\nurl = \"x\"", &[], ""));
        assert_eq!(url, Err("the url holds a control character".into()));
        let header = config_text(&request("http://127.0.0.1/", &[("X", "a\r\nY: b")], ""));
        assert_eq!(header, Err("the header holds a control character".into()));
    }

    #[test]
    fn a_c1_control_or_delete_in_the_body_is_refused() {
        for body in ["a\u{7f}b", "a\u{85}b", "a\u{1b}[31mb"] {
            let refused = config_text(&request("http://127.0.0.1/", &[], body));
            assert_eq!(
                refused,
                Err("the body holds a control character".into()),
                "{body:?}"
            );
        }
    }

    #[test]
    fn curl_messages_never_carry_the_address() {
        let message = curl_message(
            b"curl: (52) Empty reply from hooks.example.com:8080\nmore\n",
            "https://hooks.example.com:8080/secret-path",
        );
        assert_eq!(message.as_deref(), Some("(52) Empty reply from the server"));
        assert_eq!(curl_message(b"\n", "https://a.example/"), None);
    }

    #[test]
    fn only_a_failed_http_outcome_has_a_status() {
        assert_eq!(http_status(&status_outcome("503")), Some(503));
        assert_eq!(http_status(&status_outcome("204")), None);
        assert_eq!(
            http_status(&failed(DeliveryFailure::Other, "HTTP 500".into())),
            None
        );
    }
}
