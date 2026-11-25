//! The object Swift holds: one core per app run, its runtime, its sessions and its
//! lifecycle. Every method returns the JSON envelope and none blocks the caller; the
//! async ones run on the core's own runtime, so a panic there arrives as an `internal`
//! error too.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value};
use statglass_engine::wall_ms;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{MobileCall, MobileConfig};
use statglass_schema::lock::LockExt;
use statglass_session::Dialer;
use statglass_ssh::{RusshDialer, Signer, SignerError};
use tokio::runtime::{Handle, Runtime};
use tokio::sync::watch;

use crate::envelope;
use crate::ffi::{CoreEvents, NativeSigner, NetworkPath};
use crate::handover;
use crate::lifecycle::Lifecycle;
use crate::pairing;
use crate::sessions::Sessions;
use crate::signer::{NativeSignerAdapter, authorized_key_line};

/// The phone's Rust core.
#[derive(uniffi::Object)]
pub struct MobileCore {
    signer: Arc<dyn NativeSigner>,
    #[cfg(test)]
    dialer: Option<Arc<dyn Dialer>>,
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
        crate::logging::init();
        let sessions = Sessions::new(events, Some(signer.clone()));
        Arc::new(Self::initial(signer, sessions))
    }

    /// Starts the runtime and a session per host in `config_json` (a `MobileConfig`),
    /// keeping the phone's id under `data_dir`. Envelope data: `null`.
    ///
    /// # Errors
    ///
    /// Returns `invalid_argument` for an invalid config and `internal` if the core
    /// already started or could not load the phone id or create the runtime.
    pub fn start(&self, data_dir: String, config_json: String) -> String {
        envelope::run_result(|| {
            let config: MobileConfig = parse("MobileConfig", &config_json)?;
            let runtime = self.runtime()?;
            let data = config.data;
            self.sessions
                .start(runtime, PathBuf::from(data_dir), config, self.dialer())?;
            self.lifecycle.set_data_policy(data);
            Ok(())
        })
    }

    /// Answers one `MobileCall`, given as its `method` tag and its `args` as JSON
    /// (`null` or empty for a call without arguments).
    ///
    /// # Errors
    ///
    /// Returns `invalid_argument` for an invalid method or arguments and `internal`
    /// before startup or if the call task fails. Individual commands can return
    /// other `CommandError` kinds.
    pub async fn call(&self, method: String, args_json: String) -> String {
        let request = match parse_call(&method, &args_json) {
            Ok(request) => request,
            Err(error) => return envelope::encode::<()>(Err(error)),
        };
        let Some(runtime) = self.runtime.get().filter(|_| self.sessions.is_started()) else {
            return envelope::encode::<()>(Err(not_started()));
        };
        let sessions = self.sessions.clone();
        let task = match request {
            MobileCall::SetHosts { hosts } => {
                runtime.spawn_blocking(move || sessions.set_hosts(hosts).map(|()| Value::Null))
            }
            MobileCall::AuthorizedKeyLine { comment } => {
                let signer = self.signer.clone();
                runtime.spawn_blocking(move || {
                    authorized_key_line(&*signer, &comment).map(Value::String)
                })
            }
            MobileCall::BuildInfo => {
                runtime.spawn(async { to_value(crate::build_info::current()) })
            }
            MobileCall::SetDataPolicy(data) => {
                let lifecycle = self.lifecycle.clone();
                runtime.spawn(async move {
                    lifecycle.set_data_policy(data);
                    Ok(Value::Null)
                })
            }
            MobileCall::PreviewPairing { text } => {
                runtime.spawn(async move { to_value(pairing::preview(&text, wall_ms())?) })
            }
            MobileCall::Pair {
                text,
                device_name,
                model,
            } => {
                let signer = NativeSignerAdapter::new(self.signer.clone());
                runtime.spawn(async move {
                    let key = signer.public_key().await.map_err(pairing_key_error)?;
                    to_value(
                        pairing::pair(&sessions, key.to_vec(), text, device_name, model).await?,
                    )
                })
            }
            MobileCall::PairingState => {
                runtime.spawn_blocking(move || to_value(pairing::state(&sessions)))
            }
            MobileCall::DecodeBundle { text } => {
                runtime.spawn_blocking(move || to_value(handover::decode_bundle(&sessions, &text)?))
            }
            MobileCall::AddHandoverHosts { hosts } => runtime
                .spawn_blocking(move || to_value(handover::add_handover_hosts(&sessions, hosts)?)),
            other => runtime.spawn(async move { sessions.call(other).await }),
        };
        envelope::encode(joined(task.await))
    }

    /// Quiesces every session for backgrounding. The requests are issued before this
    /// returns, so a `resume` called after it is never overtaken; [`quiesced`]
    /// (Self::quiesced) waits for the sessions to close. Envelope data: `null`.
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

    /// Resolves once the most recent [`quiesce`](Self::quiesce) completes, at once when
    /// there is none. Envelope data: `null`.
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
    fn initial(signer: Arc<dyn NativeSigner>, sessions: Sessions) -> Self {
        let lifecycle = sessions.lifecycle().clone();
        Self {
            signer,
            #[cfg(test)]
            dialer: None,
            runtime: OnceLock::new(),
            sessions: Arc::new(sessions),
            lifecycle,
            quiesced: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_dialer(
        signer: Arc<dyn NativeSigner>,
        events: Arc<dyn CoreEvents>,
        dialer: Arc<dyn Dialer>,
    ) -> Arc<Self> {
        Arc::new(Self {
            dialer: Some(dialer),
            ..Self::initial(signer, Sessions::new(events, None))
        })
    }

    fn dialer(&self) -> Arc<dyn Dialer> {
        #[cfg(test)]
        if let Some(dialer) = &self.dialer {
            return dialer.clone();
        }
        let signer = Arc::new(NativeSignerAdapter::new(self.signer.clone()));
        Arc::new(RusshDialer::new(signer))
    }

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

fn pairing_key_error(error: SignerError) -> CommandError {
    match error {
        SignerError::Unavailable(_) => CommandError::PhoneKeyUnavailable,
        SignerError::Invalid(_) | SignerError::Internal(_) => CommandError::Internal {
            message: format!("reading the phone's SSH public key: {error}"),
        },
    }
}

/// A task's outcome, with a panic inside it mapped to `internal`.
fn joined(
    outcome: Result<Result<Value, CommandError>, tokio::task::JoinError>,
) -> Result<Value, CommandError> {
    outcome.unwrap_or_else(|error| match error.try_into_panic() {
        Ok(payload) => Err(envelope::panicked(payload.as_ref(), "call task")),
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
        fn public_key(&self) -> Result<Vec<u8>, crate::ffi::NativeSignerError> {
            Ok(Vec::new())
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
        MobileCore::with_dialer(
            Arc::new(NoKey),
            Arc::new(NoEvents),
            Arc::new(crate::sessions::tests::PeerDialer(
                tokio::sync::mpsc::unbounded_channel().0,
            )),
        )
    }

    fn ok_null(envelope: &str) -> bool {
        serde_json::from_str::<Value>(envelope).ok()
            == Some(json!({ "status": "ok", "data": null }))
    }

    #[test]
    fn quiesce_returns_at_once_and_quiesced_resolves_without_sources() {
        let core = core();
        let dir = tempfile::tempdir().expect("temp dir");
        let config = json!({ "hosts": [], "data": { "live_on_cellular": false } }).to_string();
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

    #[test]
    fn a_failed_start_leaves_calls_unavailable_until_start_succeeds() {
        let core = core();
        let dir = tempfile::tempdir().unwrap();
        let phone_id = dir.path().join("phone-id");
        let path = dir.path().display().to_string();
        let config = json!({ "hosts": [], "data": { "live_on_cellular": false } }).to_string();
        let build_info = || {
            let result = futures_lite_block_on(core.call("build_info".into(), "".into()));
            serde_json::from_str::<Value>(&result).unwrap()
        };

        assert_eq!(build_info()["error"]["kind"], "internal");
        std::fs::write(&phone_id, "invalid phone id").unwrap();
        let failed = core.start(path.clone(), config.clone());
        assert_eq!(
            serde_json::from_str::<Value>(&failed).unwrap()["error"]["kind"],
            "internal"
        );
        assert_eq!(build_info()["error"]["kind"], "internal");

        std::fs::remove_file(phone_id).unwrap();
        assert!(ok_null(&core.start(path, config)));
        assert_eq!(build_info()["status"], "ok");
    }
}
