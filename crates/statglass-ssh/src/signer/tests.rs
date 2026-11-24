use super::*;
use p256::{ecdsa::signature::Verifier, pkcs8::EncodePrivateKey};

#[tokio::test]
async fn software_key_round_trips_pkcs8_and_verifies_with_the_authorized_key() {
    let key = SoftwareSigner::generate();
    let document = key.key.to_pkcs8_der().unwrap();
    let loaded = SoftwareSigner::from_pkcs8_der(document.as_bytes()).unwrap();
    assert_eq!(key.public_key(), loaded.public_key());
    assert_eq!(loaded.public_key().len(), 65);

    let text = loaded.authorized_key_line("fixture key");
    let public = PublicKey::from_openssh(&text).unwrap();
    assert_eq!(public.algorithm().as_str(), "ecdsa-sha2-nistp256");
    assert_eq!(public.comment().as_bytes(), b"fixture key");
    let point = public.key_data().ecdsa().unwrap().as_sec1_bytes();
    assert_eq!(point, loaded.public_key());
    let verifying = VerifyingKey::from_sec1_bytes(point).unwrap();
    let data = b"SSH authentication request";
    let der = loaded.sign(data.to_vec()).await.unwrap();
    let signature = ecdsa::Signature::from_der(&der).unwrap();
    verifying.verify(data, &signature).unwrap();
    assert!(verifying.verify(b"different request", &signature).is_err());
}

#[test]
fn ssh_mpints_pad_high_bits_and_keep_short_scalars_minimal() {
    // The DER INTEGERs represent r = 0x80 and s = 0x01.
    let high_r = [0x30, 0x07, 0x02, 0x02, 0x00, 0x80, 0x02, 0x01, 0x01];
    assert_eq!(
        der_to_ssh_signature(&high_r).unwrap(),
        [0, 0, 0, 2, 0, 0x80, 0, 0, 0, 1, 1]
    );
    let short_r = [0x30, 0x06, 0x02, 0x01, 0x05, 0x02, 0x01, 0x01];
    assert_eq!(
        der_to_ssh_signature(&short_r).unwrap(),
        [0, 0, 0, 1, 5, 0, 0, 0, 1, 1]
    );
}

#[test]
fn rejects_malformed_der_and_invalid_p256_scalars() {
    for der in [
        &[0x30, 0x01][..],                                 // Truncated sequence.
        &[0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01], // Zero r.
        &[0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01], // Negative r.
    ] {
        assert!(matches!(
            der_to_ssh_signature(der),
            Err(SignerError::Invalid(_))
        ));
    }
}
