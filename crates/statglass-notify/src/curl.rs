//! Runs one request through the system's curl and classifies the result. The only module
//! in the crate that spawns a process.
//!
//! The whole request, URL and headers included, goes to curl as a config on stdin
//! (`curl -q -K -`), so no token or webhook URL appears in the process list. Every config
//! value is double-quoted with backslash, quote, newline, carriage return and tab
//! escaped. The body may hold newlines, carriage returns and tabs; any other control
//! character, and any control character at all in the URL or a header, is refused before
//! curl runs. Only http and https are allowed, redirects are not followed, URL globbing
//! is off, and curl's exit code names transport failures while the status code decides
//! the rest (plan/rfc-alerts.md 6.4).
//!
//! curl runs with an empty environment in `/`. Proxy variables (`http_proxy`,
//! `https_proxy`, `ALL_PROXY`) and custom CA variables (`CURL_CA_BUNDLE`,
//! `SSL_CERT_FILE`) are deliberately not honoured: a proxy inherited from whatever
//! launched the app would receive the request and its `Authorization` header.

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

/// curl's command-line arguments: `-q` first, then `--globoff`, `--proto =http,https`,
/// `--max-redirs 0`, `--max-time <timeout_secs>`, `--silent --show-error`,
/// `--output /dev/null`, `--write-out %{http_code}` and `-K -`. Never the URL, a header
/// or the body, which travel on stdin.
pub fn arguments(timeout_secs: u32) -> Vec<String> {
    // `-q` only works as the first argument; it keeps the user's ~/.curlrc out.
    // `--globoff` sends `{a,b}` and `[1-9]` in a URL literally instead of expanding them
    // into several requests. There is no `--fail`: the status code is read from
    // `--write-out` and decides the outcome.
    [
        "-q",
        "--globoff",
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

/// One curl run: its outcome, and the HTTP status when the server answered.
pub(crate) struct Attempt {
    pub outcome: DeliveryOutcome,
    /// The status the server answered with, `None` when no answer arrived.
    pub http_status: Option<u16>,
}

/// Sends `request` once through the curl at `curl` and classifies the result: a 2xx
/// status is `Delivered`, any other status `Failed { Http, "HTTP <code>" }`; exit 6
/// `NameNotFound`, 7 `ConnectFailed`, 28 `TimedOut`, 35 and 60 `Tls`; a missing binary
/// `CurlMissing`; a refused control character in the request `Rejected` without
/// spawning; anything else `Other` with "curl error <n>". curl runs with an empty
/// environment, so proxy and custom CA variables are deliberately not honoured.
/// Blocking.
pub fn run(curl: &Path, request: &HttpRequest, timeout_secs: u32) -> DeliveryOutcome {
    attempt(curl, request, timeout_secs).outcome
}

/// [`run`], keeping the HTTP status for the retry policy.
pub(crate) fn attempt(curl: &Path, request: &HttpRequest, timeout_secs: u32) -> Attempt {
    let config = match config_text(request) {
        Ok(config) => config,
        Err(reason) => return no_answer(DeliveryFailure::Rejected, format!("Not sent: {reason}")),
    };
    let child = match spawn(curl, timeout_secs) {
        Ok(child) => child,
        Err(attempt) => return attempt,
    };
    match finish(child, &config) {
        Ok(output) => classify(&output, &request.url, timeout_secs),
        Err(error) => no_answer(
            DeliveryFailure::Other,
            format!("Could not pass the request to curl: {error}"),
        ),
    }
}

/// The curl command: an empty environment, `/` as its directory, every stream piped.
fn command(curl: &Path, timeout_secs: u32) -> Command {
    let mut command = isolated(curl);
    command
        .args(arguments(timeout_secs))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// `program` with no inherited environment, run from `/`.
fn isolated(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.env_clear().current_dir("/");
    command
}

/// Starts curl, or the attempt that explains why it did not start.
fn spawn(curl: &Path, timeout_secs: u32) -> Result<Child, Attempt> {
    command(curl, timeout_secs)
        .spawn()
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => no_answer(
                DeliveryFailure::CurlMissing,
                format!("curl is not installed at {}", curl.display()),
            ),
            _ => no_answer(
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

/// The attempt of a finished curl run, from its exit code, the status code it wrote to
/// stdout and its stderr.
fn classify(output: &Output, url: &str, timeout_secs: u32) -> Attempt {
    let Some(code) = output.status.code() else {
        return no_answer(
            DeliveryFailure::Other,
            "curl was stopped before it finished".into(),
        );
    };
    let (reason, detail) = match code {
        0 => return answered(&String::from_utf8_lossy(&output.stdout)),
        EXIT_COULDNT_RESOLVE_HOST => (
            DeliveryFailure::NameNotFound,
            "Server name not found".into(),
        ),
        EXIT_COULDNT_CONNECT => (DeliveryFailure::ConnectFailed, "Could not connect".into()),
        EXIT_OPERATION_TIMEDOUT => (
            DeliveryFailure::TimedOut,
            format!("Timed out after {timeout_secs} s"),
        ),
        EXIT_SSL_CONNECT_ERROR | EXIT_PEER_FAILED_VERIFICATION => {
            (DeliveryFailure::Tls, "TLS error".into())
        }
        code => (
            DeliveryFailure::Other,
            curl_error(code, &output.stderr, url),
        ),
    };
    no_answer(reason, detail)
}

/// The attempt of a run that reached the server: `Delivered` for 2xx, `Failed { Http }`
/// for any other status.
fn answered(written: &str) -> Attempt {
    let Ok(status) = written.trim().parse::<u16>() else {
        return no_answer(
            DeliveryFailure::Other,
            "curl reported no HTTP status".into(),
        );
    };
    let outcome = if (200..300).contains(&status) {
        DeliveryOutcome::Delivered { status }
    } else {
        DeliveryOutcome::Failed {
            reason: DeliveryFailure::Http,
            detail: format!("HTTP {status}"),
        }
    };
    Attempt {
        outcome,
        http_status: Some(status),
    }
}

/// "curl error <code>: <message>" from curl's first stderr line without its
/// "curl: (<code>) " prefix, or just "curl error <code>" when there is no message or it
/// names the URL or its host.
fn curl_error(code: i32, stderr: &[u8], url: &str) -> String {
    let label = format!("curl error {code}");
    let stderr = String::from_utf8_lossy(stderr);
    let Some(line) = stderr.lines().map(str::trim).find(|line| !line.is_empty()) else {
        return label;
    };
    let message = line.strip_prefix("curl: ").unwrap_or(line);
    let message = message
        .strip_prefix(&format!("({code}) "))
        .unwrap_or(message);
    let host = url_host(url);
    if message.is_empty() || message.contains(url) || contains_word(message, host) {
        return label;
    }
    format!("{label}: {message}")
}

/// The host of `url`, without scheme, userinfo, port or path; empty when there is none.
fn url_host(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_and_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, after)| after);
    match host_and_port.split_once(']') {
        Some((bracketed, _)) => bracketed.trim_start_matches('['),
        None => host_and_port.split(':').next().unwrap_or_default(),
    }
}

/// Whether `word` appears in `text` with no letter, digit, `.`, `-` or `_` on either
/// side. An empty word never appears.
fn contains_word(text: &str, word: &str) -> bool {
    let is_word_char = |c: char| c.is_alphanumeric() || matches!(c, '.' | '-' | '_');
    !word.is_empty()
        && text.match_indices(word).any(|(at, _)| {
            let before = text.get(..at).and_then(|head| head.chars().next_back());
            let after = text
                .get(at + word.len()..)
                .and_then(|tail| tail.chars().next());
            !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char)
        })
}

/// A failed attempt that got no HTTP answer.
fn no_answer(reason: DeliveryFailure, detail: String) -> Attempt {
    Attempt {
        outcome: DeliveryOutcome::Failed { reason, detail },
        http_status: None,
    }
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
    fn curl_runs_with_an_empty_environment_in_the_root_directory() {
        let curl = command(Path::new("/usr/bin/curl"), 10);
        assert_eq!(curl.get_current_dir(), Some(Path::new("/")));
        // `get_envs` lists only explicit changes, so run the same setup and read what the
        // child actually sees.
        let env = isolated(Path::new("/usr/bin/env")).output().unwrap();
        assert!(env.status.success());
        assert_eq!(String::from_utf8_lossy(&env.stdout), "");
        let pwd = isolated(Path::new("/bin/pwd")).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&pwd.stdout), "/\n");
    }

    #[test]
    fn an_unmapped_curl_error_keeps_its_message_unless_it_names_the_server() {
        let url = "https://hooks.example.com:8080/secret-path";
        assert_eq!(
            curl_error(52, b"curl: (52) Empty reply from server\nmore\n", url),
            "curl error 52: Empty reply from server"
        );
        assert_eq!(
            curl_error(52, b"curl: (52) Empty reply from server\n", "http://e/"),
            "curl error 52: Empty reply from server"
        );
        for stderr in [
            &b"curl: (56) Recv failure from hooks.example.com\n"[..],
            b"curl: (3) bad URL https://hooks.example.com:8080/secret-path\n",
            b"\n",
            b"",
        ] {
            assert_eq!(curl_error(56, stderr, url), "curl error 56", "{stderr:?}");
        }
        assert_eq!(
            curl_error(
                56,
                b"curl: (56) Recv failure from hooks.example.community\n",
                url
            ),
            "curl error 56: Recv failure from hooks.example.community"
        );
    }

    #[test]
    fn only_an_answer_carries_a_status() {
        assert_eq!(answered("503").http_status, Some(503));
        assert_eq!(
            answered("204").outcome,
            DeliveryOutcome::Delivered { status: 204 }
        );
        assert_eq!(answered("").http_status, None);
    }
}
