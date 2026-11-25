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
    fn public_key(&self) -> &[u8] {
        if let Some(cached) = self.public_key.get() {
            return cached;
        }
        if let Ok(key) = self.native.public_key()
            && matches!(key.as_slice(), [4, coordinates @ ..] if coordinates.len() == 64)
        {
            return self.public_key.get_or_init(|| key);
        }
        self.public_key.get().map_or(&[], Vec::as_slice)
    }

    fn sign(&self, data: Vec<u8>) -> BoxFuture<'static, Result<Vec<u8>, SignerError>> {
        let native = self.native.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || native.sign(data))
                .await
                .map_err(|error| {
                    SignerError::Unavailable(format!("running native signer: {error}"))
                })?
                .map_err(|error| match error {
                    NativeSignerError::Unavailable { message }
                    | NativeSignerError::Unexpected { message } => {
                        SignerError::Unavailable(message)
                    }
                    NativeSignerError::Refused { message } => SignerError::Refused(message),
                })
        })
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
    let key = native
        .public_key()
        .map_err(|error| CommandError::Internal {
            message: format!("reading the phone's SSH public key: {error}"),
        })?;
    statglass_ssh::authorized_key_line(&key, comment).map_err(|error| CommandError::Internal {
        message: format!("formatting the phone's SSH public key: {error}"),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier as _};
    use statglass_schema::lock::LockExt;
    use statglass_ssh::SoftwareSigner;

    use super::*;

    struct SoftwareNative {
        signer: SoftwareSigner,
        public_key: Mutex<Vec<u8>>,
        key_reads: AtomicUsize,
        runtime_thread: std::thread::ThreadId,
    }

    impl SoftwareNative {
        fn new(signer: SoftwareSigner) -> Self {
            let public_key = Mutex::new(signer.public_key().to_vec());
            Self {
                signer,
                public_key,
                key_reads: AtomicUsize::new(0),
                runtime_thread: std::thread::current().id(),
            }
        }
    }

    impl NativeSigner for SoftwareNative {
        fn public_key(&self) -> Result<Vec<u8>, NativeSignerError> {
            self.key_reads.fetch_add(1, Ordering::Relaxed);
            Ok(self.public_key.lock_ok().clone())
        }

        fn sign(&self, data: Vec<u8>) -> Result<Vec<u8>, NativeSignerError> {
            assert_ne!(std::thread::current().id(), self.runtime_thread);
            Ok(tokio::runtime::Handle::current()
                .block_on(self.signer.sign(data))
                .unwrap())
        }
    }

    type NativeFailure = fn(String) -> NativeSignerError;

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

    #[tokio::test]
    async fn signs_off_the_runtime_thread_with_the_cached_key() {
        let native = Arc::new(SoftwareNative::new(SoftwareSigner::generate()));
        let adapter = NativeSignerAdapter::new(native.clone());
        assert_eq!(native.key_reads.load(Ordering::Relaxed), 0);
        assert_eq!(adapter.public_key(), native.signer.public_key());

        let message = b"SSH authentication request";
        let der = adapter.sign(message.to_vec()).await.unwrap();
        let signature = Signature::from_der(&der).unwrap();
        let public = VerifyingKey::from_sec1_bytes(adapter.public_key()).unwrap();
        public.verify(message, &signature).unwrap();

        assert_eq!(native.key_reads.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn a_key_created_after_start_can_authenticate() {
        let native = Arc::new(SoftwareNative::new(SoftwareSigner::generate()));
        native.public_key.lock_ok().clear();
        let adapter = NativeSignerAdapter::new(native.clone());
        assert!(adapter.public_key().is_empty());

        let public = native.signer.public_key();
        let mut wrong_prefix = public.to_vec();
        wrong_prefix[0] = 2;
        for malformed in [wrong_prefix, public[..64].to_vec()] {
            *native.public_key.lock_ok() = malformed;
            assert!(adapter.public_key().is_empty());
        }

        *native.public_key.lock_ok() = public.to_vec();
        assert_eq!(adapter.public_key(), public);

        let message = b"SSH authentication after pairing";
        let der = adapter.sign(message.to_vec()).await.unwrap();
        let signature = Signature::from_der(&der).unwrap();
        let key = VerifyingKey::from_sec1_bytes(adapter.public_key()).unwrap();
        key.verify(message, &signature).unwrap();
    }

    #[tokio::test]
    async fn signing_errors_keep_the_native_message_and_refusal() {
        let cases: [(NativeFailure, bool); 3] = [
            (|message| NativeSignerError::Unavailable { message }, false),
            (|message| NativeSignerError::Unexpected { message }, false),
            (|message| NativeSignerError::Refused { message }, true),
        ];
        for (error, refused) in cases {
            let adapter = NativeSignerAdapter::new(Arc::new(FailingNative {
                key: SoftwareSigner::generate().public_key().to_vec(),
                error,
            }));
            match (refused, adapter.sign(vec![]).await.unwrap_err()) {
                (true, SignerError::Refused(message))
                | (false, SignerError::Unavailable(message)) => {
                    assert_eq!(message, "native failure detail");
                }
                result => panic!("wrong signer failure: {result:?}"),
            }
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
