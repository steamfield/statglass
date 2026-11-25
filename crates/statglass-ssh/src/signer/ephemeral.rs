use statglass_session::BoxFuture;

use super::{Signer, SignerError};

/// The one-time pairing key from a QR: a P-256 scalar held in memory for one pairing.
pub struct EphemeralSigner {
    _private: (),
}

impl EphemeralSigner {
    /// # Errors
    ///
    /// Always returns `SignerError::Invalid` until the pairing signer is implemented.
    pub fn from_scalar(_scalar: &[u8; 32]) -> Result<Self, SignerError> {
        Err(SignerError::Invalid("not implemented".into()))
    }
}

impl Signer for EphemeralSigner {
    fn public_key(&self) -> BoxFuture<'_, Result<&[u8], SignerError>> {
        Box::pin(async { Err(SignerError::Invalid("not implemented".into())) })
    }

    fn sign(&self, _data: Vec<u8>) -> BoxFuture<'static, Result<Vec<u8>, SignerError>> {
        Box::pin(async { Err(SignerError::Invalid("not implemented".into())) })
    }
}
