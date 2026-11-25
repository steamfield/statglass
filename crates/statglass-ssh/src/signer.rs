//! The key that authenticates the phone: a P-256 signer behind a trait, so the Secure
//! Enclave and an in-memory test key share one path into russh.
use p256::ecdsa::{self, VerifyingKey, signature::Verifier as _};
use russh::keys::{Algorithm, EcdsaCurve, HashAlg, PublicKey, agent::AgentIdentity};
use russh::keys::{
    ssh_encoding::{Encode, Mpint},
    ssh_key::{Signature, public::EcdsaPublicKey},
};
use statglass_session::BoxFuture;

mod ephemeral;
pub use ephemeral::EphemeralSigner;

#[cfg(any(test, feature = "software-signer"))]
use p256::{
    Sec1Point,
    ecdsa::{SigningKey, signature::Signer as _},
    elliptic_curve::Generate,
    pkcs8::DecodePrivateKey,
};

type Result<T> = std::result::Result<T, SignerError>;

/// Signs SSH authentication requests with a P-256 key the caller holds.
pub trait Signer: Send + Sync + 'static {
    /// SEC1 uncompressed P-256 point, 65 bytes (what SecKeyCopyExternalRepresentation returns).
    fn public_key(&self) -> BoxFuture<'_, Result<&[u8]>>;
    /// ECDSA P-256 over SHA-256 of `data`, ASN.1 DER (SecKeyCreateSignature .ecdsaSignatureMessageX962SHA256).
    fn sign(&self, data: Vec<u8>) -> BoxFuture<'static, std::result::Result<Vec<u8>, SignerError>>;
}

/// Why the signer could not supply a usable public key or signature.
#[derive(Debug, thiserror::Error)]
pub enum SignerError {
    #[error("signing key unavailable: {0}")]
    Unavailable(String),
    #[error("invalid signature: {0}")]
    Invalid(String),
    #[error("native signer failed: {0}")]
    Internal(String),
}

/// An ASN.1 DER ECDSA signature as the SSH `ecdsa-sha2-nistp256` signature blob: the
/// mpint `r` followed by the mpint `s`.
pub fn der_to_ssh_signature(der: &[u8]) -> Result<Vec<u8>> {
    ssh_signature_blob(&parse_der(der)?)
}

/// The `authorized_keys` line for a SEC1 uncompressed P-256 point (65 bytes), ending in
/// `comment`: `ecdsa-sha2-nistp256 <base64> <comment>`.
pub fn authorized_key_line(public_sec1: &[u8], comment: &str) -> Result<String> {
    if !matches!(public_sec1, [4, coordinates @ ..] if coordinates.len() == 64) {
        return Err(SignerError::Invalid(format!(
            "expected a 65-byte uncompressed P-256 point, got {} bytes",
            public_sec1.len()
        )));
    }
    let key = VerifyingKey::from_sec1_bytes(public_sec1)
        .map_err(|err| SignerError::Invalid(format!("P-256 point: {err}")))?;
    let encoded = PublicKey::from(EcdsaPublicKey::from(&key))
        .to_openssh()
        .map_err(|err| SignerError::Invalid(format!("OpenSSH public key: {err}")))?;
    Ok(format!("{encoded} {comment}"))
}

fn parse_der(der: &[u8]) -> Result<ecdsa::Signature> {
    ecdsa::Signature::from_der(der).map_err(|err| SignerError::Invalid(format!("P-256 DER: {err}")))
}

fn ssh_signature_blob(signature: &ecdsa::Signature) -> Result<Vec<u8>> {
    let (r, s) = signature.split_bytes();
    let mut blob = Vec::new();
    for scalar in [r, s] {
        Mpint::from_positive_bytes(&scalar)
            .encode(&mut blob)
            .map_err(|err| SignerError::Invalid(format!("SSH mpint: {err}")))?;
    }
    Ok(blob)
}

pub(crate) struct RusshSigner<'a> {
    signer: &'a dyn Signer,
    key: VerifyingKey,
}

impl<'a> RusshSigner<'a> {
    pub fn new(signer: &'a dyn Signer, point: &[u8]) -> Option<Self> {
        if !matches!(point, [4, coordinates @ ..] if coordinates.len() == 64) {
            return None;
        }
        let key = VerifyingKey::from_sec1_bytes(point).ok()?;
        Some(Self { signer, key })
    }

    pub fn public_key(&self) -> PublicKey {
        EcdsaPublicKey::from(&self.key).into()
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum AuthError {
    #[error(transparent)]
    Signer(#[from] SignerError),
    #[error(transparent)]
    Send(#[from] russh::SendError),
}

impl russh::Signer for RusshSigner<'_> {
    type Error = AuthError;

    async fn auth_sign(
        &mut self,
        _key: &AgentIdentity,
        _hash_alg: Option<HashAlg>,
        mut data: Vec<u8>,
    ) -> std::result::Result<Vec<u8>, AuthError> {
        let der = self.signer.sign(data.clone()).await?;
        let parsed = parse_der(&der)?;
        let blob = ssh_signature_blob(&parsed)?;
        self.key.verify(&data, &parsed).map_err(|_| {
            SignerError::Invalid("signature does not verify with the signer's public key".into())
        })?;
        let algorithm = Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP256,
        };
        let signature = Signature::new(algorithm, blob)
            .map_err(|err| SignerError::Invalid(format!("SSH signature: {err}")))?;
        // russh expects the original authentication request with an SSH string appended.
        signature
            .encode_prefixed(&mut data)
            .map_err(|err| SignerError::Invalid(format!("SSH signature: {err}")))?;
        Ok(data)
    }
}

/// A P-256 key held in memory, for tests and the Docker harness.
#[cfg(any(test, feature = "software-signer"))]
pub struct SoftwareSigner {
    key: SigningKey,
    public: Sec1Point,
}

#[cfg(any(test, feature = "software-signer"))]
impl SoftwareSigner {
    /// A new random key.
    pub fn generate() -> Self {
        Self::from_key(SigningKey::generate())
    }

    /// The key in a PKCS#8 DER file, as `scripts/ssh-docker/run.sh` writes it.
    pub fn from_pkcs8_der(der: &[u8]) -> Result<Self> {
        SigningKey::from_pkcs8_der(der)
            .map(Self::from_key)
            .map_err(|err| SignerError::Invalid(format!("P-256 PKCS#8 key: {err}")))
    }

    /// The uncompressed P-256 point held by this in-memory signer.
    pub fn public_key(&self) -> &[u8] {
        self.public.as_bytes()
    }

    /// The `authorized_keys` line for this key, ending in `comment`.
    pub fn authorized_key_line(&self, comment: &str) -> String {
        let key = PublicKey::from(EcdsaPublicKey::from(self.key.verifying_key()));
        let encoded = key
            .to_openssh()
            .expect("a fixed-size P-256 public key fits the OpenSSH encoding");
        format!("{encoded} {comment}")
    }

    fn from_key(key: SigningKey) -> Self {
        let public = key.verifying_key().to_sec1_point(false);
        Self { key, public }
    }
}

#[cfg(any(test, feature = "software-signer"))]
impl Signer for SoftwareSigner {
    fn public_key(&self) -> BoxFuture<'_, Result<&[u8]>> {
        Box::pin(async { Ok(self.public_key()) })
    }

    fn sign(&self, data: Vec<u8>) -> BoxFuture<'static, Result<Vec<u8>>> {
        let signature: ecdsa::signature::Result<ecdsa::Signature> = self.key.try_sign(&data);
        Box::pin(async move {
            signature
                .map(|value| value.to_der().as_bytes().to_vec())
                .map_err(|err| SignerError::Internal(err.to_string()))
        })
    }
}

#[cfg(test)]
mod tests;
