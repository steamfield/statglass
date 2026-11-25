//! The hosts a controller offers to a phone.

use serde::{Deserialize, Serialize};
use statglass_schema::HostId;

use crate::pairing::{BundleHost, PairError};

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

pub fn encode_bundle(_bundle: &HostBundle) -> String {
    "SGB1:".into()
}

pub fn decode_bundle(_text: &str) -> Result<HostBundle, PairError> {
    Err(PairError::Invalid)
}
