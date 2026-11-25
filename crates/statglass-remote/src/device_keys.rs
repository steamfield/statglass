//! The device-key contract shared by restricted serving, pairing and the Mac: how a
//! paired phone is named ([`DeviceTag`]) and the one seam ([`DeviceKeys`]) through which
//! StatGlass adds or removes keys on a host (RFC `plan/rfc-ios-app.md` 2.3 to 2.5).
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::fmt;

/// A paired device's short name: the first 3 bytes of the SHA-256 of its SEC1 public
/// key, written as 6 uppercase hex characters on the wire and in `authorized_keys`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DeviceTag([u8; 3]);

impl DeviceTag {
    /// Exactly 6 uppercase hex characters, or `None`.
    pub fn parse(s: &str) -> Option<Self> {
        let bytes = s.as_bytes();
        if bytes.len() != 6 {
            return None;
        }
        let mut tag = [0u8; 3];
        let (pairs, _) = bytes.as_chunks::<2>();
        for (out, &[high, low]) in tag.iter_mut().zip(pairs) {
            *out = (upper_hex_digit(high)? << 4) | upper_hex_digit(low)?;
        }
        Some(Self(tag))
    }

    /// The tag of `key`: the first 3 bytes of the SHA-256 of its SEC1 encoding.
    pub fn from_key(key: &EcdsaP256Public) -> Self {
        let digest = Sha256::digest(key.0);
        Self([digest[0], digest[1], digest[2]])
    }
}

/// The value of one uppercase hex digit; lowercase and anything else is refused.
fn upper_hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

impl fmt::Display for DeviceTag {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let [a, b, c] = self.0;
        write!(f, "{a:02X}{b:02X}{c:02X}")
    }
}

impl Serialize for DeviceTag {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for DeviceTag {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text).ok_or_else(|| {
            serde::de::Error::custom(format!(
                "device tag {text:?} is not 6 uppercase hex characters"
            ))
        })
    }
}

/// A P-256 public key, SEC1 uncompressed (65 bytes, leading `0x04`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EcdsaP256Public(pub [u8; 65]);

/// One phone with a `statglass-mobile:` line in `authorized_keys`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairedDevice {
    pub tag: DeviceTag,
    /// The device name the phone sent, sanitized.
    pub name: String,
    /// The key's OpenSSH fingerprint, `"SHA256:"` followed by unpadded base64.
    pub fingerprint: String,
}

/// Why a device-key edit or read failed. An edit that fails leaves the file unchanged.
#[derive(Debug, thiserror::Error)]
pub enum DeviceKeysError {
    #[error("authorized_keys: {0}")]
    Io(#[from] std::io::Error),
    #[error("authorized_keys: {0}")]
    Invalid(String),
    /// A scaffold stub that a phase 5 lane has not implemented yet.
    #[error("not implemented")]
    NotImplemented,
}

/// The only way StatGlass adds or removes keys on a host.
pub trait DeviceKeys: Send + Sync {
    /// Every `statglass-mobile:` line.
    fn list_devices(&self) -> Result<Vec<PairedDevice>, DeviceKeysError>;
    /// Installs `key` for the device `name`, forced to `command`; idempotent per tag.
    fn add_device(
        &self,
        key: &EcdsaP256Public,
        name: &str,
        command: &str,
    ) -> Result<DeviceTag, DeviceKeysError>;
    /// Removes `tag`'s line; false when there was none.
    fn revoke(&self, tag: DeviceTag) -> Result<bool, DeviceKeysError>;
    /// Installs the one-time pairing key for `nonce`, expiring at `expires_ms` (UTC).
    fn add_pairing(
        &self,
        key: &EcdsaP256Public,
        nonce: &str,
        expires_ms: i64,
        command: &str,
    ) -> Result<(), DeviceKeysError>;
    /// Removes `nonce`'s pairing line; false when there was none.
    fn remove_pairing(&self, nonce: &str) -> Result<bool, DeviceKeysError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tag_is_exactly_six_uppercase_hex_characters() {
        let tag = DeviceTag::parse("7F3A2C").unwrap();
        assert_eq!(tag.to_string(), "7F3A2C");
        for bad in ["7f3a2c", "7F3A2", "7F3A2C0", "7F3A2G", "", "7F 3A2"] {
            assert_eq!(DeviceTag::parse(bad), None, "{bad:?}");
        }
        assert_eq!(
            serde_json::to_value(tag).unwrap(),
            serde_json::json!("7F3A2C")
        );
        assert_eq!(
            serde_json::from_str::<DeviceTag>(r#""7F3A2C""#).unwrap(),
            tag
        );
        assert!(serde_json::from_str::<DeviceTag>(r#""7f3a2c""#).is_err());
    }

    #[test]
    fn a_keys_tag_is_the_start_of_its_sha256() {
        let mut sec1 = [0u8; 65];
        sec1[0] = 4;
        let key = EcdsaP256Public(sec1);
        let digest = Sha256::digest(sec1);
        let expected = format!("{:02X}{:02X}{:02X}", digest[0], digest[1], digest[2]);
        assert_eq!(DeviceTag::from_key(&key).to_string(), expected);
    }
}
