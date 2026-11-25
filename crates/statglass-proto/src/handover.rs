//! The hosts a controller offers to a phone.

use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
use ciborium::value::Value;
use serde::{Deserialize, Serialize};
use statglass_schema::HostId;

use crate::pairing::{
    BundleHost, BundleHostKey, BundleRoute, BundleTarget, PairError, decode_qr, encode_qr,
};

const PREFIX: &str = "SGB1:";
const VERSION: u8 = 1;
// Paste also accepts bundles larger than a QR. Bound the decode before allocating.
const MAX_TEXT: usize = 32 * 1024;
const ED25519: &str = "ssh-ed25519";
const SHA256: &str = "SHA256:";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoverReason {
    ProxyJump,
    ProxyCommand,
    LanLiteral,
    NoHostKey,
    Unresolvable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnavailableHost {
    pub host_id: HostId,
    pub name: String,
    pub reason: HandoverReason,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostBundle {
    pub version: u8,
    pub from: HostId,
    pub hosts: Vec<BundleHost>,
    pub unavailable: Vec<UnavailableHost>,
    pub issued_ms: i64,
}

// Positional CBOR fields omit repeated names. A null host user uses the bundle's
// common user; a null OS means Linux. LAN targets and ed25519 pins are scalars.
#[derive(Serialize, Deserialize)]
struct WireBundle(
    u8,
    HostId,
    i64,
    Option<String>,
    Vec<WireHost>,
    Vec<UnavailableHost>,
);

#[derive(Serialize, Deserialize)]
struct WireHost(
    HostId,
    String,
    Option<String>,
    Option<String>,
    Option<u16>,
    Vec<WireTarget>,
    Vec<Value>,
);

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum WireTarget {
    Lan(String),
    Tailscale([String; 1]),
}

impl WireHost {
    fn encode(host: &BundleHost, common_user: Option<&str>) -> Self {
        Self(
            host.host_id,
            host.name.clone(),
            (host.os != "linux").then(|| host.os.clone()),
            (common_user != Some(host.user.as_str())).then(|| host.user.clone()),
            host.port,
            host.targets
                .iter()
                .map(|target| match target.route {
                    BundleRoute::Lan => WireTarget::Lan(target.host.clone()),
                    BundleRoute::Tailscale => WireTarget::Tailscale([target.host.clone()]),
                })
                .collect(),
            host.host_keys.iter().map(wire_key).collect(),
        )
    }

    fn decode(self, common_user: Option<&str>) -> Result<BundleHost, PairError> {
        let Self(host_id, name, os, user, port, targets, keys) = self;
        Ok(BundleHost {
            host_id,
            name,
            os: os.unwrap_or_else(|| "linux".into()),
            user: user
                .or_else(|| common_user.map(str::to_owned))
                .ok_or(PairError::Invalid)?,
            port,
            targets: targets
                .into_iter()
                .map(|target| match target {
                    WireTarget::Lan(host) => BundleTarget {
                        route: BundleRoute::Lan,
                        host,
                    },
                    WireTarget::Tailscale([host]) => BundleTarget {
                        route: BundleRoute::Tailscale,
                        host,
                    },
                })
                .collect(),
            host_keys: keys.into_iter().map(bundle_key).collect::<Result<_, _>>()?,
        })
    }
}

fn wire_key(key: &BundleHostKey) -> Value {
    if let Some(text) = key.sha256.strip_prefix(SHA256)
        && let Ok(bytes) = STANDARD_NO_PAD.decode(text)
        && bytes.len() == 32
    {
        return if key.algorithm == ED25519 {
            Value::Bytes(bytes)
        } else {
            Value::Array(vec![
                Value::Text(key.algorithm.clone()),
                Value::Bytes(bytes),
            ])
        };
    }
    Value::Array(vec![
        Value::Text(key.algorithm.clone()),
        Value::Text(key.sha256.clone()),
    ])
}

fn bundle_key(key: Value) -> Result<BundleHostKey, PairError> {
    match key {
        Value::Bytes(bytes) if bytes.len() == 32 => Ok(BundleHostKey {
            algorithm: ED25519.into(),
            sha256: format!("{SHA256}{}", STANDARD_NO_PAD.encode(bytes)),
        }),
        Value::Array(values) => {
            let [Value::Text(algorithm), fingerprint] =
                <[Value; 2]>::try_from(values).map_err(|_| PairError::Invalid)?
            else {
                return Err(PairError::Invalid);
            };
            let sha256 = match fingerprint {
                Value::Text(text) => text,
                Value::Bytes(bytes) if bytes.len() == 32 => {
                    format!("{SHA256}{}", STANDARD_NO_PAD.encode(bytes))
                }
                _ => return Err(PairError::Invalid),
            };
            Ok(BundleHostKey { algorithm, sha256 })
        }
        _ => Err(PairError::Invalid),
    }
}

pub fn encode_bundle(bundle: &HostBundle) -> String {
    let user = bundle
        .hosts
        .first()
        .map(|host| host.user.as_str())
        .filter(|user| bundle.hosts.iter().all(|host| host.user == *user));
    let wire = WireBundle(
        bundle.version,
        bundle.from,
        bundle.issued_ms,
        user.map(str::to_owned),
        bundle
            .hosts
            .iter()
            .map(|host| WireHost::encode(host, user))
            .collect(),
        bundle.unavailable.clone(),
    );
    let mut body = Vec::new();
    // All fields have infallible serde implementations, and Vec writes cannot fail.
    ciborium::into_writer(&wire, &mut body).expect("host bundle serializes to a Vec");
    encode_qr(PREFIX, body)
}

pub fn decode_bundle(text: &str) -> Result<HostBundle, PairError> {
    let WireBundle(version, from, issued_ms, user, hosts, unavailable) =
        decode_qr(text, PREFIX, MAX_TEXT)?;
    if version != VERSION {
        return Err(PairError::Invalid);
    }
    Ok(HostBundle {
        version,
        from,
        issued_ms,
        hosts: hosts
            .into_iter()
            .map(|host| host.decode(user.as_deref()))
            .collect::<Result<_, _>>()?,
        unavailable,
    })
}
