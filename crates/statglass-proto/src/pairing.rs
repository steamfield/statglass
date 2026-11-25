//! What a pairing QR carries and what the forced `pair` command says (RFC
//! `plan/rfc-ios-app.md` 2.4, D-145, D-151). The payload is `"SGP1:"` + base45(CBOR);
//! base45 is written here rather than taken from a crate.
use crate::CodecError;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use statglass_schema::HostId;
use std::time::Duration;

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

const PREFIX: &str = "SGP1:";
const BASE45: &[u8; 45] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const MAX_QR_TEXT: usize = 4096;
pub const PAYLOAD_VERSION: u8 = 1;
/// An accepted start can receive the host's decision for one control request and poll
/// interval after the offer stops accepting starts and approvals.
pub const PAIR_RECEIPT_GRACE: Duration = Duration::from_secs(11);

// Positional fields keep the QR small. PairStart and PairReply keep their own wire layout.
#[derive(Serialize, Deserialize)]
struct QrPayload(u8, QrHost, [u8; 32], String, String, i64);

#[derive(Serialize, Deserialize)]
struct QrHost(
    HostId,
    String,
    String,
    String,
    Option<u16>,
    Vec<(BundleRoute, String)>,
    Vec<(String, String)>,
);

impl From<&BundleHost> for QrHost {
    fn from(host: &BundleHost) -> Self {
        Self(
            host.host_id,
            host.name.clone(),
            host.os.clone(),
            host.user.clone(),
            host.port,
            host.targets
                .iter()
                .map(|target| (target.route, target.host.clone()))
                .collect(),
            host.host_keys
                .iter()
                .map(|key| (key.algorithm.clone(), key.sha256.clone()))
                .collect(),
        )
    }
}

impl From<QrHost> for BundleHost {
    fn from(QrHost(host_id, name, os, user, port, targets, host_keys): QrHost) -> Self {
        Self {
            host_id,
            name,
            os,
            user,
            port,
            targets: targets
                .into_iter()
                .map(|(route, host)| BundleTarget { route, host })
                .collect(),
            host_keys: host_keys
                .into_iter()
                .map(|(algorithm, sha256)| BundleHostKey { algorithm, sha256 })
                .collect(),
        }
    }
}

/// The QR text for `p`: `"SGP1:"` + base45(CBOR followed by its CRC-32/ISO-HDLC).
pub fn encode_payload(p: &PairingPayload) -> String {
    let mut bytes = Vec::new();
    let compact = QrPayload(
        p.version,
        QrHost::from(&p.host),
        p.pairing_key,
        p.nonce.clone(),
        p.code.clone(),
        p.expires_ms,
    );
    // All fields have infallible serde implementations, and Vec writes cannot fail.
    ciborium::into_writer(&compact, &mut bytes).expect("pairing payload serializes to a Vec");
    bytes.extend_from_slice(&checksum(&bytes).to_be_bytes());
    let mut text = String::from(PREFIX);
    for chunk in bytes.chunks(2) {
        let (mut value, digits) = match chunk {
            [high, low] => (usize::from(u16::from_be_bytes([*high, *low])), 3),
            [last] => (usize::from(*last), 2),
            _ => break,
        };
        for _ in 0..digits {
            text.push(char::from(BASE45[value % 45]));
            value /= 45;
        }
    }
    text
}

/// Reads QR text, refusing an expired, wrong-version, corrupt or malformed payload.
pub fn decode_payload(s: &str, now_ms: i64) -> Result<PairingPayload, PairError> {
    if s.len() > MAX_QR_TEXT {
        return Err(PairError::Invalid);
    }
    let encoded = s.strip_prefix(PREFIX).ok_or(PairError::Invalid)?;
    let bytes = decode_base45(encoded.as_bytes())?;
    let (body, crc) = bytes.split_last_chunk::<4>().ok_or(PairError::Invalid)?;
    if checksum(body) != u32::from_be_bytes(*crc) {
        return Err(PairError::Invalid);
    }
    let QrPayload(version, host, pairing_key, nonce, code, expires_ms) =
        decode_pair_body(body).map_err(|_| PairError::Invalid)?;
    if version != PAYLOAD_VERSION
        || now_ms >= expires_ms
        || !valid_nonce(&nonce)
        || code.len() != 6
        || !code.chars().all(|c| CODE_ALPHABET.contains(c))
    {
        return Err(PairError::Invalid);
    }
    Ok(PairingPayload {
        version,
        host: host.into(),
        pairing_key,
        nonce,
        code,
        expires_ms,
    })
}

/// A nonce is also the suffix of the Linux pairing socket and a forced-command argument.
pub fn valid_nonce(nonce: &str) -> bool {
    nonce.len() == 32 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn decode_base45(encoded: &[u8]) -> Result<Vec<u8>, PairError> {
    fn digit(byte: u8) -> Result<usize, PairError> {
        BASE45
            .iter()
            .position(|&d| d == byte)
            .ok_or(PairError::Invalid)
    }
    let mut bytes = Vec::with_capacity(encoded.len() / 3 * 2 + 1);
    for chunk in encoded.chunks(3) {
        match chunk {
            [a, b, c] => {
                let value = digit(*a)? + digit(*b)? * 45 + digit(*c)? * 45 * 45;
                let value = u16::try_from(value).map_err(|_| PairError::Invalid)?;
                bytes.extend_from_slice(&value.to_be_bytes());
            }
            [a, b] => {
                let value = digit(*a)? + digit(*b)? * 45;
                bytes.push(u8::try_from(value).map_err(|_| PairError::Invalid)?);
            }
            _ => return Err(PairError::Invalid),
        }
    }
    Ok(bytes)
}

fn checksum(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

/// Pairing uses the proto u32-length CBOR framing and only carries small messages.
pub const MAX_PAIR_FRAME_BYTES: usize = 16 * 1024;

/// Encodes a CBOR pairing value with a four-byte big-endian length prefix.
///
/// # Errors
///
/// Returns `Encode` on a serialization failure or `TooLarge` above [`MAX_PAIR_FRAME_BYTES`].
pub fn encode_pair_frame(value: &impl Serialize) -> Result<Vec<u8>, CodecError> {
    let mut frame = vec![0; 4];
    ciborium::into_writer(value, &mut frame).map_err(|e| CodecError::Encode(e.to_string()))?;
    let len = frame.len() - 4;
    if len > MAX_PAIR_FRAME_BYTES {
        return Err(CodecError::TooLarge(len as u64));
    }
    frame[..4].copy_from_slice(&(len as u32).to_be_bytes());
    Ok(frame)
}

/// Decodes a pairing frame body after the caller has checked its length.
///
/// # Errors
///
/// Returns `Decode` for malformed CBOR or trailing bytes.
pub fn decode_pair_body<T: DeserializeOwned>(mut body: &[u8]) -> Result<T, CodecError> {
    let value = ciborium::from_reader(&mut body).map_err(|e| CodecError::Decode(e.to_string()))?;
    if !body.is_empty() {
        return Err(CodecError::Decode("trailing bytes in pairing data".into()));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> PairingPayload {
        PairingPayload {
            version: PAYLOAD_VERSION,
            host: BundleHost {
                host_id: HostId(uuid::Uuid::from_u128(123)),
                name: "Office workstation".into(),
                os: "linux".into(),
                user: "riley".into(),
                port: Some(22),
                targets: [
                    "workstation.local",
                    "192.168.1.42",
                    "fd00::123",
                    "100.64.4.2",
                ]
                .into_iter()
                .map(|host| BundleTarget {
                    route: if host.starts_with("100.") {
                        BundleRoute::Tailscale
                    } else {
                        BundleRoute::Lan
                    },
                    host: host.into(),
                })
                .collect(),
                host_keys: ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"]
                    .into_iter()
                    .map(|algorithm| BundleHostKey {
                        algorithm: algorithm.into(),
                        sha256: format!("SHA256:{}", "a".repeat(43)),
                    })
                    .collect(),
            },
            pairing_key: [222; 32],
            nonce: "0123456789abcdef0123456789abcdef".into(),
            code: "ABC234".into(),
            expires_ms: 1_800_000_060_000,
        }
    }

    #[test]
    fn pairing_payload_round_trips_a_full_single_host_under_1200_bytes() {
        let payload = payload();
        let text = encode_payload(&payload);
        assert!(text.starts_with("SGP1:"));
        assert!(text.len() < 1200, "{} bytes", text.len());
        assert_eq!(decode_payload(&text, payload.expires_ms - 1), Ok(payload));
    }

    #[test]
    fn pairing_payload_rejects_expiry_version_checksum_and_invalid_fields() {
        let good = payload();
        let text = encode_payload(&good);
        let now = good.expires_ms - 1;
        assert_eq!(
            decode_payload(&text, good.expires_ms),
            Err(PairError::Invalid)
        );
        let mut corrupt = text.clone();
        corrupt.replace_range(
            5..6,
            if corrupt.get(5..6) == Some("0") {
                "1"
            } else {
                "0"
            },
        );
        for bad in [
            String::new(),
            "SGP1:".into(),
            "SGP1:A".into(),
            "SGP1:::".into(),
            "SGP1::::".into(),
            corrupt,
            text.replacen("SGP1:", "SGP2:", 1),
        ] {
            assert_eq!(decode_payload(&bad, now), Err(PairError::Invalid));
        }
        for bad in [
            PairingPayload {
                version: 2,
                ..good.clone()
            },
            PairingPayload {
                nonce: "../escape".into(),
                ..good.clone()
            },
            PairingPayload {
                code: "ABC01L".into(),
                ..good.clone()
            },
            PairingPayload {
                code: "ABC23".into(),
                ..good
            },
        ] {
            assert_eq!(
                decode_payload(&encode_payload(&bad), now),
                Err(PairError::Invalid)
            );
        }
    }

    #[test]
    fn pairing_base45_and_checksum_match_standard_vectors() {
        assert_eq!(decode_base45(b"BB8").unwrap(), b"AB");
        assert_eq!(decode_base45(b"%69 VD92EX0").unwrap(), b"Hello!!");
        assert_eq!(checksum(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn pairing_replies_match_the_waiting_wire_fixture_and_round_trip_errors() {
        const WAITING: &[u8] = b"\0\0\0\x0e\xa1\x64kind\x67waiting";
        assert_eq!(encode_pair_frame(&PairReply::Waiting).unwrap(), WAITING);
        assert_eq!(
            decode_pair_body::<PairReply>(&WAITING[4..]).unwrap(),
            PairReply::Waiting
        );
        let error = PairReply::Error {
            error: PairError::Used,
        };
        assert_eq!(
            decode_pair_body::<PairReply>(&encode_pair_frame(&error).unwrap()[4..]).unwrap(),
            error
        );
        let mut malformed = WAITING[4..].to_vec();
        malformed.push(0);
        assert!(decode_pair_body::<PairReply>(&malformed).is_err());
    }
}
