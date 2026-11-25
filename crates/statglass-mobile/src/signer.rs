//! The bridge from Swift's [`NativeSigner`] to the russh dialer's `Signer`, and the
//! `authorized_keys` line for the phone's key (phase 4 lane d).

use std::sync::{Arc, OnceLock};

use statglass_ipc::error::CommandError;
use statglass_session::BoxFuture;
use statglass_ssh::{Signer, SignerError};

use crate::ffi::{NativeSigner, NativeSignerError};

/// The native key, as the dialer signs with it.
///
/// The adapter retries native reads until it receives a 65-byte uncompressed key.
/// Regenerating the key requires rebuilding the core's sessions.
pub(crate) struct NativeSignerAdapter {
    native: Arc<dyn NativeSigner>,
    public_key: OnceLock<Vec<u8>>,
}

impl NativeSignerAdapter {
    pub(crate) fn new(native: Arc<dyn NativeSigner>) -> Self {
        Self {
            native,
            public_key: OnceLock::new(),
        }
    }
}

impl Signer for NativeSignerAdapter {
    fn public_key(&self) -> BoxFuture<'_, Result<&[u8], SignerError>> {
        Box::pin(async {
            if let Some(cached) = self.public_key.get() {
                return Ok(cached.as_slice());
            }
            let native = self.native.clone();
            let key = tokio::task::spawn_blocking(move || native.public_key())
                .await
                .map_err(task_error)?
                .map_err(native_error)?;
            if !matches!(key.as_slice(), [4, coordinates @ ..] if coordinates.len() == 64) {
                return Err(SignerError::Invalid(
                    "expected a 65-byte uncompressed P-256 public key".into(),
                ));
            }
            Ok(self.public_key.get_or_init(|| key).as_slice())
        })
    }

    fn sign(&self, data: Vec<u8>) -> BoxFuture<'static, Result<Vec<u8>, SignerError>> {
        let native = self.native.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || native.sign(data))
                .await
                .map_err(task_error)?
                .map_err(native_error)
        })
    }
}

fn task_error(error: tokio::task::JoinError) -> SignerError {
    SignerError::Internal(format!("running native signer: {error}"))
}

fn native_error(error: NativeSignerError) -> SignerError {
    match error {
        NativeSignerError::Unavailable { message } => SignerError::Unavailable(message),
        NativeSignerError::Unexpected { message } => SignerError::Internal(message),
    }
}

/// `ecdsa-sha2-nistp256 <base64> <comment>` for the phone's key.
///
/// # Errors
///
/// The comment contains a line break, or the native key cannot be encoded.
pub(crate) fn authorized_key_line(
    native: &dyn NativeSigner,
    comment: &str,
) -> Result<String, CommandError> {
    if comment.contains(['\r', '\n']) {
        return Err(CommandError::InvalidArgument {
            message: "The SSH public key comment must fit on one line.".into(),
        });
    }
    let key = native.public_key().map_err(|error| match error {
        NativeSignerError::Unavailable { .. } => CommandError::PhoneKeyUnavailable,
        error @ NativeSignerError::Unexpected { .. } => CommandError::Internal {
            message: format!("reading the phone's SSH public key: {error}"),
        },
    })?;
    statglass_ssh::authorized_key_line(&key, comment).map_err(|error| CommandError::Internal {
        message: format!("formatting the phone's SSH public key: {error}"),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier as _};
    use serde_json::{Value, json};
    use statglass_schema::lock::LockExt;
    use statglass_ssh::SoftwareSigner;
    use tokio::sync::Notify;

    use super::*;
    use crate::{CoreEvents, MobileCore};

    struct SoftwareNative {
        signer: SoftwareSigner,
        public_key: Mutex<Option<Vec<u8>>>,
        key_reads: AtomicUsize,
        runtime_thread: std::thread::ThreadId,
    }

    impl SoftwareNative {
        fn new(signer: SoftwareSigner) -> Self {
            let public_key = signer.public_key().to_vec();
            Self {
                signer,
                public_key: Mutex::new(Some(public_key)),
                key_reads: AtomicUsize::new(0),
                runtime_thread: std::thread::current().id(),
            }
        }
    }

    impl NativeSigner for SoftwareNative {
        fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
            self.key_reads.fetch_add(1, Ordering::Relaxed);
            self.public_key
                .lock_ok()
                .clone()
                .ok_or_else(|| NativeSignerError::Unavailable {
                    message: "fixture key is missing".into(),
                })
        }

        fn sign(&self, data: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
            assert_ne!(std::thread::current().id(), self.runtime_thread);
            Ok(tokio::runtime::Handle::current()
                .block_on(self.signer.sign(data))
                .unwrap())
        }
    }

    type NativeFailure = fn(String) -> NativeSignerError;
    type SignerFailure = fn(String) -> SignerError;

    struct FailingNative {
        key: Vec<u8>,
        error: NativeFailure,
    }

    impl NativeSigner for FailingNative {
        fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
            Ok(self.key.clone())
        }

        fn sign(&self, _: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
            Err((self.error)("native failure detail".into()))
        }
    }

    struct FailedPublicKey(NativeFailure, &'static str);

    impl NativeSigner for FailedPublicKey {
        fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
            Err((self.0)(self.1.into()))
        }

        fn sign(&self, _: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
            panic!("an unavailable public key cannot sign");
        }
    }

    #[derive(Default)]
    struct StatusEvents(Notify);

    impl CoreEvents for StatusEvents {
        fn live(&self, _: u32, _: String) -> bool {
            false
        }

        fn event(&self, _: String) {
            self.0.notify_one();
        }
    }

    #[test]
    fn mobile_core_publishes_local_signer_failures() {
        let cases: [(NativeFailure, &str, &str); 2] = [
            (
                |message| NativeSignerError::Unavailable { message },
                "Could not load the phone key (OSStatus -25300)",
                "phone_key_unavailable",
            ),
            (
                |message| NativeSignerError::Unexpected { message },
                "callback failed",
                "internal",
            ),
        ];
        let config = json!({
            "hosts": [{
                "id": "00000000-0000-0000-0000-000000000001",
                "name": "Studio",
                "user": "monitor",
                "targets": [{"route": "lan", "host": "studio.local"}],
                "host_keys": [{"algorithm": "ssh-ed25519", "sha256": "SHA256:unused"}],
                "command": {"kind": "restricted"}
            }],
            "data": {"live_on_cellular": false}
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        for (failure, diagnostic, kind) in cases {
            let dir = tempfile::tempdir().unwrap();
            let events = Arc::new(StatusEvents::default());
            let core = MobileCore::new(
                Arc::new(FailedPublicKey(failure, diagnostic)),
                events.clone(),
            );
            assert_eq!(
                serde_json::from_str::<Value>(
                    &core.start(dir.path().display().to_string(), config.to_string())
                )
                .unwrap(),
                json!({"status": "ok", "data": null})
            );
            let connection = runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        let json = core.call("list_remote_hosts".into(), "null".into()).await;
                        let reply = serde_json::from_str::<Value>(&json).unwrap();
                        assert_eq!(reply["status"], "ok", "{reply}");
                        let connection = &reply["data"][0]["connection"];
                        if !connection["failure"].is_null() {
                            break connection.clone();
                        }
                        events.0.notified().await;
                    }
                })
                .await
                .expect("core publishes the failed connection")
            });
            assert_eq!(connection["failure"], kind, "{connection}");
            assert!(
                connection["message"]
                    .as_str()
                    .is_some_and(|message| message.contains(diagnostic)),
                "{connection}"
            );
        }
    }

    #[test]
    fn an_unavailable_phone_key_has_its_own_authorized_key_line_error() {
        let signer = FailedPublicKey(
            |message| NativeSignerError::Unavailable { message },
            "Could not load the phone key (OSStatus -25300)",
        );
        let error = authorized_key_line(&signer, "iPhone").unwrap_err();
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({"kind": "phone_key_unavailable"})
        );
    }

    #[tokio::test]
    async fn signs_off_the_runtime_thread_with_the_cached_key() {
        let native = Arc::new(SoftwareNative::new(SoftwareSigner::generate()));
        let adapter = NativeSignerAdapter::new(native.clone());
        assert_eq!(native.key_reads.load(Ordering::Relaxed), 0);
        assert_eq!(
            adapter.public_key().await.unwrap(),
            native.signer.public_key()
        );

        let message = b"SSH authentication request";
        let der = adapter.sign(message.to_vec()).await.unwrap();
        let signature = Signature::from_der(&der).unwrap();
        let public = VerifyingKey::from_sec1_bytes(adapter.public_key().await.unwrap()).unwrap();
        public.verify(message, &signature).unwrap();

        assert_eq!(native.key_reads.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn a_key_created_after_start_can_authenticate() {
        let native = Arc::new(SoftwareNative::new(SoftwareSigner::generate()));
        *native.public_key.lock_ok() = None;
        let adapter = NativeSignerAdapter::new(native.clone());
        assert!(matches!(
            adapter.public_key().await,
            Err(SignerError::Unavailable(_))
        ));

        let public = native.signer.public_key();
        let mut wrong_prefix = public.to_vec();
        wrong_prefix[0] = 2;
        for malformed in [wrong_prefix, public[..64].to_vec()] {
            *native.public_key.lock_ok() = Some(malformed);
            assert!(matches!(
                adapter.public_key().await,
                Err(SignerError::Invalid(_))
            ));
        }

        *native.public_key.lock_ok() = Some(public.to_vec());
        assert_eq!(adapter.public_key().await.unwrap(), public);

        let message = b"SSH authentication after pairing";
        let der = adapter.sign(message.to_vec()).await.unwrap();
        let signature = Signature::from_der(&der).unwrap();
        let key = VerifyingKey::from_sec1_bytes(adapter.public_key().await.unwrap()).unwrap();
        key.verify(message, &signature).unwrap();
    }

    #[tokio::test]
    async fn signing_errors_keep_the_native_kind_and_message() {
        let cases: [(NativeFailure, SignerFailure); 2] = [
            (
                |message| NativeSignerError::Unavailable { message },
                SignerError::Unavailable,
            ),
            (
                |message| NativeSignerError::Unexpected { message },
                SignerError::Internal,
            ),
        ];
        for (error, expected) in cases {
            let adapter = NativeSignerAdapter::new(Arc::new(FailingNative {
                key: SoftwareSigner::generate().public_key().to_vec(),
                error,
            }));
            let actual = adapter.sign(vec![]).await.unwrap_err();
            let expected = expected("native failure detail".into());
            assert_eq!(
                std::mem::discriminant(&actual),
                std::mem::discriminant(&expected)
            );
            assert_eq!(actual.to_string(), expected.to_string());
        }
    }

    #[test]
    fn public_key_line_uses_the_same_format_as_the_software_key() {
        let native = SoftwareNative::new(SoftwareSigner::generate());
        assert_eq!(
            authorized_key_line(&native, "phone key").unwrap(),
            native.signer.authorized_key_line("phone key")
        );
    }

    #[test]
    fn a_truncated_public_key_is_an_internal_error() {
        let mut key = SoftwareSigner::generate().public_key().to_vec();
        key.truncate(64);
        let native = FailingNative {
            key,
            error: |_| panic!("formatting a public key never signs"),
        };
        let Err(CommandError::Internal { message }) = authorized_key_line(&native, "phone") else {
            panic!("expected an internal error for a truncated key");
        };
        assert!(message.contains("got 64 bytes"), "{message}");
    }

    #[test]
    fn a_multiline_comment_cannot_produce_multiple_key_lines() {
        let native = SoftwareNative::new(SoftwareSigner::generate());
        for comment in ["phone\nkey", "phone\rkey"] {
            assert_eq!(
                authorized_key_line(&native, comment),
                Err(CommandError::InvalidArgument {
                    message: "The SSH public key comment must fit on one line.".into(),
                })
            );
        }
    }
}
