//! The bridge from Swift's [`NativeSigner`] to the russh dialer's `Signer`, and the
//! `authorized_keys` line for the phone's key (phase 4 lane d).

use std::sync::Arc;

use statglass_ipc::error::CommandError;
use statglass_session::BoxFuture;
use statglass_ssh::{Signer, SignerError};

use crate::ffi::NativeSigner;

/// The native key, as the dialer signs with it.
pub(crate) struct NativeSignerAdapter {
    native: Arc<dyn NativeSigner>,
    public_key: Vec<u8>,
}

impl NativeSignerAdapter {
    /// Reads the public key once; the dialer asks for it on every connection.
    pub(crate) fn new(native: Arc<dyn NativeSigner>) -> Self {
        Self {
            native,
            public_key: Vec::new(),
        }
    }
}

impl Signer for NativeSignerAdapter {
    fn public_key(&self) -> &[u8] {
        &self.public_key
    }

    fn sign(&self, data: Vec<u8>) -> BoxFuture<'static, Result<Vec<u8>, SignerError>> {
        let _ = (&self.native, data);
        Box::pin(async { Err(SignerError::Unavailable("not implemented".into())) })
    }
}

/// `ecdsa-sha2-nistp256 <base64> <comment>` for the phone's key.
///
/// # Errors
///
/// The native key is not a 65-byte SEC1 P-256 point.
pub(crate) fn authorized_key_line(
    native: &dyn NativeSigner,
    comment: &str,
) -> Result<String, CommandError> {
    let _ = (native, comment);
    Err(CommandError::Internal {
        message: "authorized_key_line: not implemented".into(),
    })
}
