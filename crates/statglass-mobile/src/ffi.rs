//! The interfaces Swift implements for the core, and the records it passes in. These are
//! the FFI contract with `apps/mobile/modules/statglass-native`; nothing here reaches
//! TypeScript, which sees only the JSON the core sends through [`CoreEvents`].

/// Why the native signer could not sign. Rust maps every case to an authentication
/// failure that keeps the message (`statglass_ssh::SignerError`).
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum NativeSignerError {
    /// The key is missing or the Keychain or Secure Enclave would not hand it over.
    #[error("signing key unavailable: {message}")]
    Unavailable { message: String },
    /// The key exists but signing was refused.
    #[error("signing refused: {message}")]
    Refused { message: String },
    /// The Swift side threw something UniFFI did not expect.
    #[error("unexpected signer failure: {message}")]
    Unexpected { message: String },
}

impl From<uniffi::UnexpectedUniFFICallbackError> for NativeSignerError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        Self::Unexpected {
            message: error.reason,
        }
    }
}

/// The phone's SSH key, held by Swift: a Secure Enclave key on a device, a Keychain
/// `ThisDeviceOnly` software key in the simulator.
#[uniffi::export(with_foreign)]
pub trait NativeSigner: Send + Sync {
    /// The SEC1 uncompressed P-256 public key, 65 bytes.
    fn public_key(&self) -> Vec<u8>;
    /// ECDSA P-256 over SHA-256 of `data`, ASN.1 DER, unchanged from
    /// `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)`.
    ///
    /// # Errors
    ///
    /// Why the key could not sign.
    fn sign(&self, data: Vec<u8>) -> Result<Vec<u8>, NativeSignerError>;
}

/// Where the core pushes what it streams. Swift forwards each payload, unread, as an
/// Expo module event.
#[uniffi::export(with_foreign)]
pub trait CoreEvents: Send + Sync {
    /// One `LiveMsg` as JSON for the app's stream `stream`. `false` means the listener
    /// is gone and the core ends that stream.
    fn live(&self, stream: u32, message_json: String) -> bool;
    /// One `MobileEvent` as JSON.
    fn event(&self, event_json: String);
}

/// The phone's network path, from `NWPathMonitor`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NetworkPath {
    /// `NWPath.status == .satisfied`.
    pub satisfied: bool,
    /// `NWPath.isExpensive`: cellular or a personal hotspot.
    pub expensive: bool,
    /// `NWPath.isConstrained`: Low Data Mode.
    pub constrained: bool,
}
