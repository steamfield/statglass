//! The JSON result envelope every exported function returns, and the panic guard that
//! keeps a Rust panic from crossing the FFI boundary.
//!
//! The shape matches the desktop's typed command results, `{"status":"ok","data":...}`
//! or `{"status":"error","error":CommandError}`, so the TypeScript side maps both the
//! same way.

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};

use serde::Serialize;
use serde_json::json;
use statglass_ipc::error::CommandError;

/// One exported call's outcome, serialized as the command envelope.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Envelope<T> {
    Ok { data: T },
    Error { error: CommandError },
}

/// Runs `body`, catching any panic, and returns its result as the JSON envelope.
pub(crate) fn run<T: Serialize>(body: impl FnOnce() -> T) -> String {
    run_result(|| Ok(body()))
}

/// Runs a fallible `body`, catching any panic, and returns its result or its
/// `CommandError` as the JSON envelope.
pub(crate) fn run_result<T: Serialize>(body: impl FnOnce() -> Result<T, CommandError>) -> String {
    // The body's state is dropped with the panic and never observed again, so a
    // broken invariant inside it cannot leak to the caller.
    let outcome = catch_unwind(AssertUnwindSafe(body))
        .unwrap_or_else(|payload| Err(panicked(payload.as_ref(), "exported call")));
    encode(outcome)
}

/// The envelope of an outcome already computed (an awaited task's result).
pub(crate) fn encode<T: Serialize>(outcome: Result<T, CommandError>) -> String {
    let envelope = match outcome {
        Ok(data) => Envelope::Ok { data },
        Err(error) => Envelope::Error { error },
    };
    serde_json::to_string(&envelope).unwrap_or_else(|err| serialize_failure(&err))
}

/// The `internal` error for a panic payload: an exported body, or a task it awaited,
/// panicked.
pub(crate) fn panicked(payload: &(dyn Any + Send), operation: &str) -> CommandError {
    let error = CommandError::Internal {
        message: panic_message(payload),
    };
    tracing::error!(
        error = &error as &dyn std::error::Error,
        operation,
        "mobile core panic"
    );
    error
}

/// The text of a panic payload, or a fixed description when it carries no string.
fn panic_message(payload: &(dyn Any + Send)) -> String {
    let text = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str));
    match text {
        Some(text) => format!("panic in statglass-mobile: {text}"),
        None => "panic in statglass-mobile with a non-string payload".to_owned(),
    }
}

/// An internal-error envelope naming why the result could not be serialized. Built
/// from a `Value`, whose `Display` cannot fail.
fn serialize_failure(err: &serde_json::Error) -> String {
    json!({
        "status": "error",
        "error": {
            "kind": "internal",
            "message": format!("statglass-mobile could not serialize its result: {err}"),
        },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::Value;
    use statglass_schema::lock::LockExt;
    use tracing::{Level, Metadata, Subscriber, field, span};

    use super::*;

    fn parsed(text: &str) -> Value {
        serde_json::from_str(text).expect("the envelope is valid JSON")
    }

    #[test]
    fn a_returning_body_is_an_ok_envelope_with_its_data() {
        assert_eq!(
            parsed(&run(|| vec![1, 2])),
            json!({ "status": "ok", "data": [1, 2] })
        );
    }

    #[test]
    fn a_panicking_body_returns_an_internal_error_and_logs_it_once() {
        let logs = Arc::new(Mutex::new(Vec::new()));
        // Keep both dispatchers registered so interest is evaluated per thread.
        // Other tests can hit this callsite with no subscriber.
        let envelope =
            tracing::subscriber::with_default(tracing::subscriber::NoSubscriber::default(), || {
                tracing::subscriber::with_default(PanicLog(logs.clone()), || {
                    run(|| -> u8 { panic!("ring buffer gone") })
                })
            });
        assert_eq!(
            parsed(&envelope),
            json!({
                "status": "error",
                "error": {
                    "kind": "internal",
                    "message": "panic in statglass-mobile: ring buffer gone",
                },
            })
        );
        assert_eq!(
            *logs.lock_ok(),
            [Some(
                "internal error: panic in statglass-mobile: ring buffer gone".into()
            )]
        );
    }

    struct PanicLog(Arc<Mutex<Vec<Option<String>>>>);

    impl Subscriber for PanicLog {
        fn enabled(&self, metadata: &Metadata<'_>) -> bool {
            *metadata.level() == Level::ERROR
        }

        fn new_span(&self, _: &span::Attributes<'_>) -> span::Id {
            span::Id::from_u64(1)
        }

        fn record(&self, _: &span::Id, _: &span::Record<'_>) {}
        fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}
        fn enter(&self, _: &span::Id) {}
        fn exit(&self, _: &span::Id) {}

        fn event(&self, event: &tracing::Event<'_>) {
            #[derive(Default)]
            struct Capture(Option<String>);

            impl field::Visit for Capture {
                fn record_debug(&mut self, _: &field::Field, _: &dyn std::fmt::Debug) {}

                fn record_error(
                    &mut self,
                    field: &field::Field,
                    error: &(dyn std::error::Error + 'static),
                ) {
                    if field.name() == "error" {
                        self.0 = Some(error.to_string());
                    }
                }
            }

            let mut capture = Capture::default();
            event.record(&mut capture);
            self.0.lock_ok().push(capture.0);
        }
    }

    #[test]
    fn a_formatted_panic_message_is_kept() {
        let ring = "net";
        let text = run(|| -> u8 { panic!("ring {ring} gone") });
        assert_eq!(
            parsed(&text)["error"]["message"],
            "panic in statglass-mobile: ring net gone"
        );
    }

    #[test]
    fn a_command_error_is_an_error_envelope_with_its_kind() {
        let text = run_result(|| -> Result<u8, CommandError> {
            Err(CommandError::InvalidArgument {
                message: "no such method".into(),
            })
        });
        assert_eq!(
            parsed(&text),
            json!({
                "status": "error",
                "error": { "kind": "invalid_argument", "message": "no such method" },
            })
        );
    }

    #[test]
    fn a_result_that_cannot_serialize_is_an_internal_error() {
        // JSON object keys must be strings, so a tuple-keyed map fails to serialize.
        let map = std::collections::HashMap::from([((1, 2), 3)]);
        let envelope = parsed(&run(|| map));
        assert_eq!(envelope["status"], "error");
        assert_eq!(envelope["error"]["kind"], "internal");
        let message = envelope["error"]["message"].as_str().unwrap_or_default();
        assert!(
            message.starts_with("statglass-mobile could not serialize its result: "),
            "{message}"
        );
    }
}
