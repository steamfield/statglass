//! Delivery to destinations (plan/rfc-alerts.md 6.4): the request built for each kind,
//! the curl config that carries it, and the outcome of real `/usr/bin/curl` runs against
//! a local listener. No test leaves the machine: the listener is on 127.0.0.1 and the
//! name-not-found case uses the reserved `.invalid` domain.

use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use statglass_notify::curl::{arguments, config_text, run};
use statglass_notify::{
    AlertText, DeliverOptions, HttpRequest, Message, alert_text, build_request, deliver,
};
use statglass_schema::Settings;
use statglass_schema::{
    AlertCause, Cmp, DeliveryFailure, DeliveryOutcome, Destination, DestinationKind, Event,
    EventDetail, Labels, MetricId,
};
use uuid::Uuid;

const CURL: &str = "/usr/bin/curl";
const FIRED_AT: i64 = 1_800_000_000_000;

// ---------------------------------------------------------------------------------------
// Fixtures

fn ntfy(server: &str, topic: &str, token: Option<&str>) -> Destination {
    Destination {
        id: Uuid::from_u128(0xde57),
        name: "Phone".into(),
        enabled: true,
        kind: DestinationKind::Ntfy {
            server: server.into(),
            topic: topic.into(),
            token: token.map(Into::into),
        },
    }
}

fn webhook(url: &str) -> Destination {
    Destination {
        id: Uuid::from_u128(0xde58),
        name: "Team chat".into(),
        enabled: true,
        kind: DestinationKind::Webhook { url: url.into() },
    }
}

fn message() -> Message {
    Message {
        title: "Memory is tight".into(),
        body: "Memory pressure 84% · above 80% for 2 min".into(),
        host: "Studio".into(),
        rule: Some("Memory is tight".into()),
        kind: "threshold".into(),
        fired_at_ms: FIRED_AT,
    }
}

/// Options for fast tests: no waits between attempts and a short per-attempt limit.
fn fast(timeout_secs: u32) -> DeliverOptions {
    DeliverOptions {
        backoff: [Duration::ZERO; 2],
        timeout_secs,
        ..Default::default()
    }
}

/// A loopback port that refuses connections. A port taken by binding `:0` and dropping
/// the listener is free again at once, and under a parallel run another test's
/// listener or curl's own source port (a self-connect) lands on it, so the refusal
/// comes back as `Other`. Port 1 (tcpmux) sits below every ephemeral range, so neither
/// can take it; checking it refuses first names the cause if a host does listen there.
fn refused_port() -> u16 {
    const PORT: u16 = 1;
    let probe = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], PORT)),
        Duration::from_secs(2),
    );
    assert!(
        matches!(&probe, Err(e) if e.kind() == ErrorKind::ConnectionRefused),
        "127.0.0.1:{PORT} must refuse connections for this test: {probe:?}"
    );
    PORT
}

fn header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// A scratch directory under the system temp dir, removed when dropped.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "statglass-notify-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).expect("creating the scratch dir");
        Self(path)
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---------------------------------------------------------------------------------------
// A local HTTP listener

/// One request as the listener received it.
#[derive(Clone, Debug)]
struct Received {
    /// The request line and headers, without the blank line.
    head: String,
    body: Vec<u8>,
}

/// An HTTP/1.1 listener on 127.0.0.1 that answers the n-th request with the n-th status
/// of its script, records every request, and stops accepting once the script is used up
/// (later connections are refused because the socket is closed).
struct Listener {
    addr: SocketAddr,
    received: Arc<Mutex<Vec<Received>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Listener {
    fn answering(statuses: &[u16]) -> Self {
        let socket = TcpListener::bind("127.0.0.1:0").expect("binding the listener");
        socket
            .set_nonblocking(true)
            .expect("making the listener non-blocking");
        let addr = socket.local_addr().expect("reading the listener address");
        let received = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let script = statuses.to_vec();
        let thread = {
            let received = Arc::clone(&received);
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || serve(&socket, &script, &received, &stop))
        };
        Self {
            addr,
            received,
            stop,
            thread: Some(thread),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    fn received(&self) -> Vec<Received> {
        self.received
            .lock()
            .expect("the listener thread never panics holding the lock")
            .clone()
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve(socket: &TcpListener, script: &[u16], received: &Mutex<Vec<Received>>, stop: &AtomicBool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut next = 0;
    while next < script.len() && !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
        match socket.accept() {
            Ok((stream, _)) => {
                if let Some(request) = answer(stream, script[next]) {
                    received
                        .lock()
                        .expect("the test never panics holding the lock")
                        .push(request);
                }
                next += 1;
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => return,
        }
    }
}

/// Reads one request from `stream` and answers it with `status`.
fn answer(mut stream: TcpStream, status: u16) -> Option<Received> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut raw = Vec::new();
    let mut chunk = [0_u8; 4096];
    let head_end = loop {
        if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        raw.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
    let length = head
        .lines()
        .find_map(|l| {
            let (name, value) = l.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    if head.to_ascii_lowercase().contains("expect: 100-continue") {
        stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").ok()?;
    }
    let mut body = raw[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let location = if (300..400).contains(&status) {
        "Location: http://127.0.0.1:9/elsewhere\r\n"
    } else {
        ""
    };
    let reply = format!(
        "HTTP/1.1 {status} Scripted\r\n{location}Content-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(reply.as_bytes()).ok()?;
    Some(Received { head, body })
}

/// A redirect listener whose `Location` points at `target`.
fn redirecting_to(target: &str) -> (TcpListener, JoinHandle<Option<Received>>) {
    let socket = TcpListener::bind("127.0.0.1:0").expect("binding the redirect listener");
    let clone = socket.try_clone().expect("cloning the redirect listener");
    let target = target.to_owned();
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = clone.accept().ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        let mut raw = Vec::new();
        let mut chunk = [0_u8; 4096];
        while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut chunk).ok()?;
            if n == 0 {
                return None;
            }
            raw.extend_from_slice(&chunk[..n]);
        }
        let reply = format!(
            "HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(reply.as_bytes()).ok()?;
        Some(Received {
            head: String::from_utf8_lossy(&raw).into_owned(),
            body: Vec::new(),
        })
    });
    (socket, thread)
}

// ---------------------------------------------------------------------------------------
// Message

#[test]
fn a_fired_alert_becomes_the_message_with_host_and_time() {
    let event = Event {
        ts_ms: FIRED_AT,
        start_ms: FIRED_AT - 120_000,
        processes: vec![],
        detail: EventDetail::Alert {
            rule_id: Uuid::from_u128(0xa1e7),
            rule_name: "Memory is tight".into(),
            cause: AlertCause::Threshold {
                metric: MetricId::from_static("mem.pressure"),
                labels: Labels::new(),
                value: 84.0,
                op: Cmp::Gt,
                threshold: 80.0,
                for_secs: 120,
            },
        },
    };
    let text: AlertText = alert_text(&event, &Settings::default().units).unwrap();
    let expected = Message {
        title: text.title.clone(),
        body: text.body.clone(),
        host: "Studio".into(),
        rule: Some("Memory is tight".into()),
        kind: "threshold".into(),
        fired_at_ms: FIRED_AT,
    };
    assert_eq!(Message::from_alert_text(text, "Studio", FIRED_AT), expected);
}

// ---------------------------------------------------------------------------------------
// Request

#[test]
fn ntfy_posts_json_to_the_server_root() {
    let request = build_request(&ntfy("https://ntfy.sh", "statglass-4f2a", None), &message());
    assert_eq!(request.url, "https://ntfy.sh/");
    assert_eq!(
        request.headers,
        [("Content-Type".to_owned(), "application/json".to_owned())]
    );
    assert_eq!(
        request.body,
        r#"{"topic":"statglass-4f2a","title":"Memory is tight","message":"Memory pressure 84% · above 80% for 2 min","priority":4,"tags":["warning"]}"#
    );
}

#[test]
fn ntfy_sends_a_bearer_token_only_when_one_is_set() {
    let with = build_request(
        &ntfy("https://ntfy.sh", "alerts", Some("tk_example_123")),
        &message(),
    );
    assert_eq!(
        header(&with, "Authorization"),
        Some("Bearer tk_example_123")
    );
    assert_eq!(header(&with, "Content-Type"), Some("application/json"));
    assert_eq!(with.headers.len(), 2);

    for token in [None, Some("")] {
        let without = build_request(&ntfy("https://ntfy.sh", "alerts", token), &message());
        assert_eq!(header(&without, "Authorization"), None, "{token:?}");
        assert_eq!(header(&without, "Content-Type"), Some("application/json"));
    }
}

#[test]
fn a_trailing_slash_on_the_ntfy_server_is_not_doubled() {
    for server in ["https://ntfy.sh/", "https://ntfy.sh"] {
        let request = build_request(&ntfy(server, "alerts", None), &message());
        assert_eq!(request.url, "https://ntfy.sh/", "{server}");
    }
    let nested = build_request(
        &ntfy("https://example.com/ntfy/", "alerts", None),
        &message(),
    );
    assert_eq!(nested.url, "https://example.com/ntfy/");
}

#[test]
fn a_webhook_receives_every_field_with_text_and_content_for_chat_apps() {
    let url = "https://chat.example.com/hooks/abc?x=1";
    let request = build_request(&webhook(url), &message());
    assert_eq!(request.url, url);
    assert_eq!(
        request.headers,
        [("Content-Type".to_owned(), "application/json".to_owned())]
    );
    assert_eq!(
        request.body,
        r#"{"text":"Memory is tight: Memory pressure 84% · above 80% for 2 min","content":"Memory is tight: Memory pressure 84% · above 80% for 2 min","title":"Memory is tight","message":"Memory pressure 84% · above 80% for 2 min","host":"Studio","rule":"Memory is tight","kind":"threshold","fired_at_ms":1800000000000}"#
    );

    let test = Message {
        rule: None,
        kind: "test".into(),
        ..message()
    };
    let body = build_request(&webhook(url), &test).body;
    assert!(body.contains(r#""rule":null"#), "{body}");
    assert!(body.contains(r#""kind":"test""#), "{body}");
}

// ---------------------------------------------------------------------------------------
// Curl config

#[test]
fn arguments_lock_down_curl_and_never_carry_the_request() {
    let args = arguments(10);
    assert_eq!(args.first().map(String::as_str), Some("-q"));
    assert_eq!(args.get(1).map(String::as_str), Some("--globoff"));
    let pairs = [
        ("--proto", "=http,https"),
        ("--max-redirs", "0"),
        ("--max-time", "10"),
        ("--output", "/dev/null"),
        ("--write-out", "%{http_code}"),
        ("-K", "-"),
    ];
    for (flag, value) in pairs {
        let at = args
            .iter()
            .position(|a| a == flag)
            .unwrap_or_else(|| panic!("{flag} missing from {args:?}"));
        assert_eq!(args.get(at + 1).map(String::as_str), Some(value), "{flag}");
    }
    for flag in ["--silent", "--show-error"] {
        assert!(
            args.iter().any(|a| a == flag),
            "{flag} missing from {args:?}"
        );
    }
    assert!(!args.iter().any(|a| a == "--fail"), "{args:?}");
    assert_eq!(
        arguments(1)[arguments(1).iter().position(|a| a == "--max-time").unwrap() + 1],
        "1"
    );

    let request = build_request(
        &ntfy(
            "https://ntfy.example.com",
            "topic-in-args",
            Some("tk_in_args"),
        ),
        &message(),
    );
    for arg in &args {
        for leaked in [
            "ntfy.example.com",
            "topic-in-args",
            "tk_in_args",
            "Bearer",
            "Content-Type",
            "Memory",
        ] {
            assert!(!arg.contains(leaked), "{arg:?} carries {leaked:?}");
        }
        assert_ne!(arg, &request.body);
    }
}

#[test]
fn hostile_text_arrives_byte_exact_and_adds_no_config_lines() {
    let scratch = ScratchDir::new();
    let injected = scratch.0.join("statglass-pwn");
    let bodies = [
        "quote \" backslash \\ tab \t cr \r newline \n end".to_owned(),
        format!(
            "x\"\noutput = \"{}\"\nurl = \"http://127.0.0.1:9/\"\n",
            injected.display()
        ),
        "\\\"\\n\\\\ already escaped".to_owned(),
        "@/etc/hosts".to_owned(),
        "trailing backslash \\".to_owned(),
    ];
    let listener = Listener::answering(&[200; 5]);
    for body in &bodies {
        let request = HttpRequest {
            url: listener.url("/hook"),
            headers: vec![("Content-Type".into(), "text/plain; q=\"a\\b\"".into())],
            body: body.clone(),
        };
        assert_eq!(
            run(Path::new(CURL), &request, 5),
            DeliveryOutcome::Delivered { status: 200 },
            "{body:?}"
        );
    }
    let received = listener.received();
    assert_eq!(received.len(), bodies.len());
    for (got, sent) in received.iter().zip(&bodies) {
        assert_eq!(got.body, sent.as_bytes(), "{sent:?}");
        assert!(got.head.starts_with("POST /hook HTTP/1.1"), "{}", got.head);
        assert!(
            got.head.contains("Content-Type: text/plain; q=\"a\\b\""),
            "{}",
            got.head
        );
    }
    assert!(!injected.exists(), "an injected output line wrote a file");
}

#[test]
fn hostile_rule_and_process_names_reach_a_webhook_byte_exact() {
    let listener = Listener::answering(&[200]);
    let hostile = Message {
        title: "Process \"node\\worker\"\tabove 200%".into(),
        body: "pid 42 \"x\"\r\noutput = \"/tmp/statglass-pwn\"\n".into(),
        rule: Some("Rule \\ with \"quotes\"".into()),
        ..message()
    };
    let destination = webhook(&listener.url("/hook"));
    let expected = build_request(&destination, &hostile);
    assert_eq!(
        deliver(&destination, &hostile, &fast(5)),
        DeliveryOutcome::Delivered { status: 200 }
    );
    let received = listener.received();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].body, expected.body.as_bytes());
    assert!(!expected.body.is_empty());
}

#[test]
fn a_url_with_glob_characters_is_one_request_to_that_literal_path() {
    let listener = Listener::answering(&[200, 200, 200, 200]);
    let destination = webhook(&listener.url("/a{1,2}/b[1-2]"));
    assert_eq!(
        deliver(&destination, &message(), &fast(5)),
        DeliveryOutcome::Delivered { status: 200 }
    );
    let received = listener.received();
    assert_eq!(received.len(), 1);
    assert!(
        received[0].head.starts_with("POST /a{1,2}/b[1-2] HTTP/1.1"),
        "{}",
        received[0].head
    );
}

#[test]
fn a_delete_or_c1_control_in_a_title_is_escaped_and_delivered() {
    let listener = Listener::answering(&[200]);
    let destination = webhook(&listener.url("/hook"));
    let titled = Message {
        title: "proc\u{7f}name\u{85}".into(),
        ..message()
    };
    assert_eq!(
        deliver(&destination, &titled, &fast(5)),
        DeliveryOutcome::Delivered { status: 200 }
    );
    let received = listener.received();
    assert_eq!(received.len(), 1);
    let body = String::from_utf8(received[0].body.clone()).unwrap();
    assert!(body.contains(r#""title":"proc\u007fname\u0085""#), "{body}");
    assert!(!body.contains('\u{7f}'), "{body}");
}

#[test]
fn another_control_character_is_rejected_without_running_curl() {
    let missing = Path::new("/nonexistent/statglass/curl");
    let clean = HttpRequest {
        url: "http://127.0.0.1:9/hook".into(),
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: "{}".into(),
    };
    let cases = [
        (
            "url",
            HttpRequest {
                url: "http://127.0.0.1:9/ho\u{1}ok".into(),
                ..clean.clone()
            },
        ),
        (
            "header",
            HttpRequest {
                headers: vec![("Authorization".into(), "Bearer a\u{1b}b".into())],
                ..clean.clone()
            },
        ),
        (
            "body",
            HttpRequest {
                body: "bell \u{7} here".into(),
                ..clean.clone()
            },
        ),
        (
            "body",
            HttpRequest {
                body: "nul \u{0} here".into(),
                ..clean.clone()
            },
        ),
    ];
    for (field, request) in &cases {
        let err = config_text(request).unwrap_err();
        assert!(err.contains(field), "{err:?} should name {field}");
        assert!(!err.contains("Bearer") && !err.contains("here"), "{err:?}");
        // A missing curl would be CurlMissing if run tried to spawn it.
        match run(missing, request, 5) {
            DeliveryOutcome::Failed {
                reason: DeliveryFailure::Rejected,
                ..
            } => {}
            other => panic!("{field}: {other:?}"),
        }
    }
    assert!(config_text(&clean).is_ok());
}

// ---------------------------------------------------------------------------------------
// Outcomes through real curl

#[test]
fn a_2xx_answer_is_delivered() {
    for status in [200, 204] {
        let listener = Listener::answering(&[status]);
        let outcome = deliver(&webhook(&listener.url("/hook")), &message(), &fast(5));
        assert_eq!(outcome, DeliveryOutcome::Delivered { status }, "{status}");
        assert_eq!(listener.received().len(), 1);
    }
}

#[test]
fn ntfy_is_delivered_to_the_listener_with_its_json_and_token() {
    let listener = Listener::answering(&[200]);
    let destination = ntfy(&listener.url(""), "statglass-4f2a", Some("tk_example_123"));
    assert_eq!(
        deliver(&destination, &message(), &fast(5)),
        DeliveryOutcome::Delivered { status: 200 }
    );
    let received = listener.received();
    assert_eq!(received.len(), 1);
    let head = &received[0].head;
    assert!(head.starts_with("POST / HTTP/1.1"), "{head}");
    assert!(
        head.contains("Authorization: Bearer tk_example_123"),
        "{head}"
    );
    assert!(head.contains("Content-Type: application/json"), "{head}");
    assert_eq!(
        received[0].body,
        build_request(&destination, &message()).body.as_bytes()
    );
}

#[test]
fn a_4xx_answer_fails_after_one_request() {
    let listener = Listener::answering(&[403, 200, 200]);
    let outcome = deliver(&webhook(&listener.url("/hook")), &message(), &fast(5));
    assert_eq!(
        outcome,
        DeliveryOutcome::Failed {
            reason: DeliveryFailure::Http,
            detail: "HTTP 403".into()
        }
    );
    assert_eq!(listener.received().len(), 1);
}

#[test]
fn a_5xx_answer_is_retried_until_delivered() {
    let listener = Listener::answering(&[500, 200]);
    let outcome = deliver(&webhook(&listener.url("/hook")), &message(), &fast(5));
    assert_eq!(outcome, DeliveryOutcome::Delivered { status: 200 });
    assert_eq!(listener.received().len(), 2);
}

#[test]
fn three_5xx_answers_fail_after_three_requests() {
    let listener = Listener::answering(&[500, 500, 500, 200]);
    let outcome = deliver(&webhook(&listener.url("/hook")), &message(), &fast(5));
    assert_eq!(
        outcome,
        DeliveryOutcome::Failed {
            reason: DeliveryFailure::Http,
            detail: "HTTP 500".into()
        }
    );
    assert_eq!(listener.received().len(), 3);
}

#[test]
fn a_redirect_is_not_followed() {
    let target = Listener::answering(&[200]);
    let (redirect, thread) = redirecting_to(&target.url("/stolen"));
    let url = format!("http://{}/hook", redirect.local_addr().unwrap());
    let outcome = deliver(&webhook(&url), &message(), &fast(5));
    assert_eq!(
        outcome,
        DeliveryOutcome::Failed {
            reason: DeliveryFailure::Http,
            detail: "HTTP 302".into()
        }
    );
    drop(redirect);
    assert!(
        thread.join().unwrap().is_some(),
        "the redirect was asked once"
    );
    assert!(
        target.received().is_empty(),
        "the redirect target saw a request"
    );
}

#[test]
fn a_refused_port_is_connect_failed() {
    let port = refused_port();
    let outcome = deliver(
        &webhook(&format!("http://127.0.0.1:{port}/hook")),
        &message(),
        &fast(5),
    );
    assert!(
        matches!(
            outcome,
            DeliveryOutcome::Failed {
                reason: DeliveryFailure::ConnectFailed,
                ..
            }
        ),
        "{outcome:?}"
    );
}

#[test]
fn an_unknown_host_name_is_name_not_found() {
    let outcome = deliver(
        &webhook("http://statglass-delivery-test.invalid/hook"),
        &message(),
        &fast(5),
    );
    assert!(
        matches!(
            outcome,
            DeliveryOutcome::Failed {
                reason: DeliveryFailure::NameNotFound,
                ..
            }
        ),
        "{outcome:?}"
    );
}

#[test]
fn a_listener_that_never_answers_times_out() {
    // Bound and listening, so the kernel accepts the connection, but nothing reads or
    // answers it.
    let silent = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/hook", silent.local_addr().unwrap());
    let started = Instant::now();
    let outcome = deliver(&webhook(&url), &message(), &fast(1));
    assert_eq!(
        outcome,
        DeliveryOutcome::Failed {
            reason: DeliveryFailure::TimedOut,
            detail: "Timed out after 1 s".into()
        }
    );
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_missing_curl_is_curl_missing() {
    let options = DeliverOptions {
        curl: PathBuf::from("/nonexistent/statglass/curl"),
        ..fast(5)
    };
    let listener = Listener::answering(&[200]);
    let outcome = deliver(&webhook(&listener.url("/hook")), &message(), &options);
    assert_eq!(
        outcome,
        DeliveryOutcome::Failed {
            reason: DeliveryFailure::CurlMissing,
            detail: "curl is not installed at /nonexistent/statglass/curl".into()
        }
    );
    assert!(listener.received().is_empty());
}

#[test]
fn a_file_url_never_reads_the_file() {
    let outcome = deliver(&webhook("file:///etc/hosts"), &message(), &fast(5));
    assert!(
        matches!(
            outcome,
            DeliveryOutcome::Failed {
                reason: DeliveryFailure::Rejected,
                ..
            }
        ),
        "{outcome:?}"
    );

    // Even past validation, curl is restricted to http and https.
    let request = HttpRequest {
        url: "file:///etc/hosts".into(),
        headers: vec![],
        body: "{}".into(),
    };
    match run(Path::new(CURL), &request, 5) {
        DeliveryOutcome::Delivered { status } => panic!("delivered with {status}"),
        DeliveryOutcome::Failed { reason, detail } => {
            assert_ne!(reason, DeliveryFailure::Rejected, "{detail}");
            assert!(!detail.contains("localhost"), "{detail}");
            assert_ne!(detail, "not implemented");
        }
    }
}

#[test]
fn a_failure_detail_never_holds_the_url_or_token() {
    let port = refused_port();
    let destination = ntfy(
        &format!("http://127.0.0.1:{port}"),
        "topic-in-detail",
        Some("tk_in_detail"),
    );
    match deliver(&destination, &message(), &fast(5)) {
        DeliveryOutcome::Failed { reason, detail } => {
            assert_eq!(reason, DeliveryFailure::ConnectFailed);
            assert_eq!(detail, "Could not connect");
        }
        other => panic!("{other:?}"),
    }
}
