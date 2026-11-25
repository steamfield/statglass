use p256::{
    Sec1Point,
    ecdsa::{self, SigningKey, signature::Signer as _},
};
use statglass_session::BoxFuture;

use super::{Signer, SignerError};

/// The one-time pairing key from a QR: a P-256 scalar held in memory for one pairing.
pub struct EphemeralSigner {
    key: SigningKey,
    public: Sec1Point,
}

impl EphemeralSigner {
    /// # Errors
    ///
    /// Returns `SignerError::Invalid` if the scalar is zero or out of range for P-256.
    pub fn from_scalar(scalar: &[u8; 32]) -> Result<Self, SignerError> {
        let key = SigningKey::from_slice(scalar)
            .map_err(|error| SignerError::Invalid(format!("P-256 pairing key: {error}")))?;
        let public = key.verifying_key().to_sec1_point(false);
        Ok(Self { key, public })
    }
}

impl Signer for EphemeralSigner {
    fn public_key(&self) -> BoxFuture<'_, Result<&[u8], SignerError>> {
        Box::pin(async { Ok(self.public.as_bytes()) })
    }

    fn sign(&self, data: Vec<u8>) -> BoxFuture<'static, Result<Vec<u8>, SignerError>> {
        let signature: ecdsa::signature::Result<ecdsa::Signature> = self.key.try_sign(&data);
        Box::pin(async move {
            signature
                .map(|value| value.to_der().as_bytes().to_vec())
                .map_err(|error| SignerError::Internal(error.to_string()))
        })
    }
}

#[cfg(test)]
mod tests {
    use p256::ecdsa::{VerifyingKey, signature::Verifier as _};
    use russh::keys::PublicKey;

    use super::*;
    use crate::authorized_key_line;

    #[test]
    fn rejects_zero_and_out_of_range_pairing_scalars() {
        for scalar in [[0; 32], [0xff; 32]] {
            assert!(matches!(
                EphemeralSigner::from_scalar(&scalar),
                Err(SignerError::Invalid(_))
            ));
        }
    }

    #[tokio::test]
    async fn pairing_signature_verifies_against_the_authorized_key_line() {
        let signer = EphemeralSigner::from_scalar(&[7; 32]).unwrap();
        let point = signer.public_key().await.unwrap();
        let line = authorized_key_line(point, "temporary pairing key").unwrap();
        let public = PublicKey::from_openssh(&line).unwrap();
        let point = public.key_data().ecdsa().unwrap().as_sec1_bytes();
        let verifying = VerifyingKey::from_sec1_bytes(point).unwrap();
        let request = b"pairing SSH authentication request";
        let signature =
            ecdsa::Signature::from_der(&signer.sign(request.to_vec()).await.unwrap()).unwrap();
        verifying.verify(request, &signature).unwrap();
    }
}
