//! What a pairing QR carries and what the forced `pair` command says (RFC
//! `plan/rfc-ios-app.md` 2.4, D-145, D-151). The payload is `"SGP1:"` + base45(CBOR);
//! base45 is written here rather than taken from a crate.
//!
//! Scaffold: the types are the contract; phase 5 lane b implements the codec.
use serde::{Deserialize, Serialize};
use statglass_schema::HostId;

/// The characters of the six-character pairing code: no 0/O/1/I/L, so it reads aloud.
pub const CODE_ALPHABET: &str = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/// One host as a pairing payload or an approval hands it to the phone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleHost {
    pub host_id: HostId,
    pub name: String,
    pub os: String,
    pub user: String,
    pub port: Option<u16>,
    /// In preference order.
    pub targets: Vec<BundleTarget>,
    /// Every key type the host's sshd offers.
    pub host_keys: Vec<BundleHostKey>,
}

/// One address the phone may dial the host at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleTarget {
    pub route: BundleRoute,
    pub host: String,
}

/// The network a [`BundleTarget`] is reached over.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BundleRoute {
    Lan,
    Tailscale,
}

/// A host key the phone pins, as `ssh-keygen -l` names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleHostKey {
    /// The SSH key algorithm, such as `"ssh-ed25519"`.
    pub algorithm: String,
    /// `"SHA256:"` followed by unpadded base64.
    pub sha256: String,
}

/// What the pairing QR carries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingPayload {
    pub version: u8,
    pub host: BundleHost,
    /// The one-time pairing key's P-256 private scalar (D-151).
    pub pairing_key: [u8; 32],
    /// 128-bit hex; names the pairing line and the approval.
    pub nonce: String,
    /// Six characters from [`CODE_ALPHABET`], shown on both screens.
    pub code: String,
    /// When the pairing line expires, ms epoch (UTC).
    pub expires_ms: i64,
}

/// The phone's first frame on the forced `pair` command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairStart {
    pub nonce: String,
    /// The device key, SEC1 uncompressed P-256 (65 bytes).
    pub device_key: Vec<u8>,
    pub device_name: String,
    pub model: String,
}

/// Where a pairing stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PairReply {
    /// Sent to the pairing client while the host has not decided.
    Waiting,
    /// Seen only by the host's approver (Mac sheet or the agent's terminal).
    Pending {
        device_name: String,
        model: String,
        code: String,
    },
    /// The device line is installed. `hosts` is this host alone in phase 5.
    Approved {
        device: String,
        hosts: Vec<BundleHost>,
    },
    Denied,
    Expired,
    /// A struct variant, not `Error(PairError)`: an internally tagged newtype holding a
    /// unit enum serializes but does not decode back from CBOR.
    Error {
        error: PairError,
    },
}

/// Why a pairing request was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum PairError {
    #[error("pairing code already used")]
    Used,
    #[error("unknown pairing code")]
    Unknown,
    #[error("pairing unavailable on this host")]
    Unavailable,
    #[error("invalid pairing data")]
    Invalid,
}

/// The QR text for `p`: `"SGP1:"` + base45(CBOR). Scaffold stub: the bare prefix until
/// phase 5 lane b.
pub fn encode_payload(p: &PairingPayload) -> String {
    let _ = p;
    String::from("SGP1:")
}

/// Reads QR text, refusing an expired, wrong-version, corrupt or malformed payload.
/// Scaffold stub: always [`PairError::Invalid`] until phase 5 lane b.
pub fn decode_payload(s: &str, now_ms: i64) -> Result<PairingPayload, PairError> {
    let _ = (s, now_ms);
    Err(PairError::Invalid)
}
