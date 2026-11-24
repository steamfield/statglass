//! The key that authenticates the phone: a P-256 signer behind a trait, so the Secure
//! Enclave and an in-memory test key share one path into russh.
use statglass_session::BoxFuture;

/// Signs SSH authentication requests with a P-256 key the caller holds.
pub trait Signer: Send + Sync + 'static {
    /// SEC1 uncompressed P-256 point, 65 bytes (what SecKeyCopyExternalRepresentation returns).
    fn public_key(&self) -> &[u8];
    /// ECDSA P-256 over SHA-256 of `data`, ASN.1 DER (SecKeyCreateSignature .ecdsaSignatureMessageX962SHA256).
    fn sign(&self, data: Vec<u8>) -> BoxFuture<'static, std::result::Result<Vec<u8>, SignerError>>;
}

/// Why the signer produced no usable signature. The dialer reports each as
/// `RemoteError::Authentication`.
#[derive(Debug, thiserror::Error)]
pub enum SignerError {
    #[error("signing key unavailable: {0}")]
    Unavailable(String),
    #[error("signing refused: {0}")]
    Refused(String),
    #[error("invalid signature: {0}")]
    Invalid(String),
}

/// An ASN.1 DER ECDSA signature as the SSH `ecdsa-sha2-nistp256` signature blob: the
/// mpint `r` followed by the mpint `s`.
pub fn der_to_ssh_signature(_der: &[u8]) -> std::result::Result<Vec<u8>, SignerError> {
    unimplemented!("phase 2 lane c")
}

/// A P-256 key held in memory, for tests and the Docker harness.
#[cfg(any(test, feature = "software-signer"))]
pub struct SoftwareSigner;

#[cfg(any(test, feature = "software-signer"))]
impl SoftwareSigner {
    /// A new random key.
    pub fn generate() -> Self {
        unimplemented!("phase 2 lane c")
    }

    /// The key in a PKCS#8 DER file, as `scripts/ssh-docker/run.sh` writes it.
    pub fn from_pkcs8_der(_der: &[u8]) -> std::result::Result<Self, SignerError> {
        unimplemented!("phase 2 lane c")
    }

    /// The `authorized_keys` line for this key, ending in `comment`.
    pub fn authorized_key_line(&self, _comment: &str) -> String {
        unimplemented!("phase 2 lane c")
    }
}

#[cfg(any(test, feature = "software-signer"))]
impl Signer for SoftwareSigner {
    fn public_key(&self) -> &[u8] {
        unimplemented!("phase 2 lane c")
    }

    fn sign(
        &self,
        _data: Vec<u8>,
    ) -> BoxFuture<'static, std::result::Result<Vec<u8>, SignerError>> {
        unimplemented!("phase 2 lane c")
    }
}
