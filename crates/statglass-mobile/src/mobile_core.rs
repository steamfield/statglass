//! The object Swift holds: one core per app run, its runtime, its sessions and its
//! lifecycle. Every method returns the JSON envelope and none blocks the caller; the
//! async ones run on the core's own runtime, so a panic there arrives as an `internal`
//! error too.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value};
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{MobileCall, MobileConfig};
use statglass_schema::lock::LockExt;
use tokio::runtime::{Handle, Runtime};
use tokio::sync::watch;

use crate::envelope;
use crate::ffi::{CoreEvents, NativeSigner, NetworkPath};
use crate::lifecycle::Lifecycle;
use crate::sessions::Sessions;
use crate::signer::{NativeSignerAdapter, authorized_key_line};

/// The phone's Rust core.
#[derive(uniffi::Object)]
pub struct MobileCore {
    signer: Arc<dyn NativeSigner>,
    runtime: OnceLock<Runtime>,
    sessions: Arc<Sessions>,
    lifecycle: Arc<Lifecycle>,
    /// Completion of the most recent quiesce, for [`quiesced`](Self::quiesced).
    quiesced: Mutex<Option<watch::Receiver<bool>>>,
}

#[uniffi::export]
impl MobileCore {
    /// A core that signs with `signer` and pushes streams to `events`. Nothing runs until
    /// [`start`](Self::start).
    #[uniffi::constructor]
    pub fn new(signer: Arc<dyn NativeSigner>, events: Arc<dyn CoreEvents>) -> Arc<Self> {
        Arc::new(Self {
            signer,
            runtime: OnceLock::new(),
            sessions: Arc::new(Sessions::new(events)),
            lifecycle: Arc::new(Lifecycle::new()),
            quiesced: Mutex::new(None),
        })
    }

    /// Starts the runtime and a session per host in `config_json` (a `MobileConfig`),
    /// keeping mirrors and the phone's id under `data_dir`. Envelope data: `null`.
    pub fn start(&self, data_dir: String, config_json: String) -> String {
        envelope::run_result(|| {
            let config: MobileConfig = parse("MobileConfig", &config_json)?;
            let runtime = self.runtime()?;
            let signer = Arc::new(NativeSignerAdapter::new(self.signer.clone()));
            let data = config.data;
            self.sessions.start(
                runtime,
                PathBuf::from(data_dir),
                config,
                signer,
                self.lifecycle.sync_policy(),
            )?;
            // The cellular setting decides the policy once the first path arrives.
            self.lifecycle.set_data_policy(&*self.sessions, data);
            Ok(())
        })
    }

    /// Answers one `MobileCall`, given as its `method` tag and its `args` as JSON
    /// (`null` or empty for a call without arguments).
    pub async fn call(&self, method: String, args_json: String) -> String {
        let request = match parse_call(&method, &args_json) {
            Ok(request) => request,
            Err(error) => return envelope::encode::<()>(Err(error)),
        };
        let Some(runtime) = self.runtime.get().map(|r| r.handle().clone()) else {
            return envelope::encode::<()>(Err(not_started()));
        };
        let (sessions, lifecycle, signer) = (
            self.sessions.clone(),
            self.lifecycle.clone(),
            self.signer.clone(),
        );
        let task = runtime.spawn(async move {
            match request {
                MobileCall::BuildInfo => to_value(crate::build_info::current()),
                MobileCall::SetHosts { hosts } => sessions
                    .set_hosts(hosts, lifecycle.sync_policy())
                    .map(|()| Value::Null),
                MobileCall::SetDataPolicy(data) => {
                    lifecycle.set_data_policy(&*sessions, data);
                    Ok(Value::Null)
                }
                MobileCall::AuthorizedKeyLine { comment } => {
                    authorized_key_line(&*signer, &comment).map(Value::String)
                }
                other => sessions.call(other).await,
            }
        });
        envelope::encode(joined(task.await))
    }

    /// Quiesces every session for backgrounding. The requests are issued before this
    /// returns, so a `resume` called after it is never overtaken; [`quiesced`]
    /// (Self::quiesced) waits for the mirror writes. Envelope data: `null`.
    pub fn quiesce(&self) -> String {
        envelope::run(|| {
            let Some(runtime) = self.runtime.get().map(|r| r.handle().clone()) else {
                // Nothing started, so nothing to wait for.
                return;
            };
            let parked = self.lifecycle.quiesce(&*self.sessions);
            let (done, wait) = watch::channel(false);
            *self.quiesced.lock_ok() = Some(wait);
            runtime.spawn(async move {
                parked.await;
                // No receiver left only means nobody is waiting any more.
                let _ = done.send(true);
            });
        })
    }

    /// Resolves once the most recent [`quiesce`](Self::quiesce) has committed its
    /// in-flight mirror writes, at once when there is none. Envelope data: `null`.
    pub async fn quiesced(&self) -> String {
        let Some(mut wait) = self.quiesced.lock_ok().clone() else {
            return envelope::encode(Ok(Value::Null));
        };
        // A closed channel means the waiting task ended, panicked or not; either way
        // there is nothing left to wait for.
        let _ = wait.wait_for(|done| *done).await;
        envelope::encode(Ok(Value::Null))
    }

    /// Resumes every session after foregrounding, the open host first. Returns at once.
    /// Envelope data: `null`.
    pub fn resume(&self) -> String {
        envelope::run(|| self.lifecycle.resume(&*self.sessions))
    }

    /// Reports the phone's new network path. Returns at once. Envelope data: `null`.
    pub fn path_changed(&self, path: NetworkPath) -> String {
        envelope::run(|| self.lifecycle.path_changed(&*self.sessions, path))
    }
}

impl MobileCore {
    /// The core's runtime, built on first use: multi-threaded, so sources, streams and
    /// blocking queries share it.
    fn runtime(&self) -> Result<Handle, CommandError> {
        if let Some(runtime) = self.runtime.get() {
            return Ok(runtime.handle().clone());
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("statglass-core")
            .build()
            .map_err(|e| CommandError::Internal {
                message: format!("statglass-mobile could not start its runtime: {e}"),
            })?;
        Ok(self.runtime.get_or_init(|| runtime).handle().clone())
    }
}

/// A task's outcome, with a panic inside it mapped to `internal`.
fn joined(
    outcome: Result<Result<Value, CommandError>, tokio::task::JoinError>,
) -> Result<Value, CommandError> {
    outcome.unwrap_or_else(|error| match error.try_into_panic() {
        Ok(payload) => Err(envelope::panicked(payload.as_ref())),
        Err(error) => Err(CommandError::Internal {
            message: format!("statglass-mobile call cancelled: {error}"),
        }),
    })
}

/// Reassembles `call(method, args_json)` into its `MobileCall`.
fn parse_call(method: &str, args_json: &str) -> Result<MobileCall, CommandError> {
    let mut request = Map::new();
    request.insert("method".into(), Value::String(method.to_owned()));
    let args = args_json.trim();
    if !args.is_empty() && args != "null" {
        request.insert("args".into(), parse::<Value>("call arguments", args)?);
    }
    serde_json::from_value(Value::Object(request)).map_err(|e| CommandError::InvalidArgument {
        message: format!("statglass-mobile call {method}: {e}"),
    })
}

fn parse<T: serde::de::DeserializeOwned>(what: &str, json: &str) -> Result<T, CommandError> {
    serde_json::from_str(json).map_err(|e| CommandError::InvalidArgument {
        message: format!("statglass-mobile: {what} is not valid: {e}"),
    })
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, CommandError> {
    serde_json::to_value(value).map_err(|e| CommandError::Internal {
        message: format!("statglass-mobile could not serialize its result: {e}"),
    })
}

fn not_started() -> CommandError {
    CommandError::Internal {
        message: "statglass-mobile: call before start".into(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_call_without_arguments_parses_from_its_method_alone() {
        assert_eq!(parse_call("list_hosts", "null"), Ok(MobileCall::ListHosts));
        assert_eq!(parse_call("list_hosts", ""), Ok(MobileCall::ListHosts));
    }

    #[test]
    fn a_call_with_arguments_parses_them_as_its_content() {
        assert_eq!(
            parse_call("unsubscribe_live", &json!({ "stream": 7 }).to_string()),
            Ok(MobileCall::UnsubscribeLive { stream: 7 })
        );
    }

    struct NoKey;

    impl NativeSigner for NoKey {
        fn public_key(&self) -> Vec<u8> {
            Vec::new()
        }

        fn sign(&self, _data: Vec<u8>) -> Result<Vec<u8>, crate::ffi::NativeSignerError> {
            Err(crate::ffi::NativeSignerError::Unavailable {
                message: "no key in this test".into(),
            })
        }
    }

    struct NoEvents;

    impl CoreEvents for NoEvents {
        fn live(&self, _stream: u32, _message_json: String) -> bool {
            false
        }

        fn event(&self, _event_json: String) {}
    }

    fn core() -> Arc<MobileCore> {
        MobileCore::new(Arc::new(NoKey), Arc::new(NoEvents))
    }

    fn ok_null(envelope: &str) -> bool {
        serde_json::from_str::<Value>(envelope).ok()
            == Some(json!({ "status": "ok", "data": null }))
    }

    #[test]
    fn quiesce_returns_at_once_and_quiesced_resolves_without_sources() {
        let core = core();
        let dir = tempfile::tempdir().expect("temp dir");
        let config = json!({ "hosts": [], "data": { "sync_on_cellular": false } }).to_string();
        assert!(ok_null(
            &core.start(dir.path().display().to_string(), config)
        ));

        assert!(ok_null(&core.quiesce()));
        let waited = futures_lite_block_on(core.quiesced());
        assert!(ok_null(&waited), "{waited}");
        assert!(ok_null(&core.resume()));
    }

    #[test]
    fn quiesced_before_any_quiesce_resolves_at_once() {
        let core = core();
        assert!(
            ok_null(&core.quiesce()),
            "quiesce before start has nothing to park"
        );
        assert!(ok_null(&futures_lite_block_on(core.quiesced())));
    }

    /// Drives a future on a current-thread runtime, as Swift's await would.
    fn futures_lite_block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime")
            .block_on(future)
    }

    #[test]
    fn an_unknown_method_is_an_invalid_argument_naming_it() {
        let Err(CommandError::InvalidArgument { message }) = parse_call("drop_tables", "null")
        else {
            panic!("an unknown method must be an invalid argument");
        };
        assert!(message.contains("drop_tables"), "{message}");
    }
}
