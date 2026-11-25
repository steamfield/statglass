//! The controller's device-key intents for remote hosts.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use statglass_schema::HostId;

use crate::{DeviceTag, EcdsaP256Public};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum IntentOp {
    Install {
        key: String,
        name: String,
    },
    Revoke,
    Applied {
        #[serde(rename = "applied_seq")]
        seq: u64,
    },
    Failed {
        #[serde(rename = "failed_seq")]
        seq: u64,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntentRecord {
    pub seq: u64,
    pub host: HostId,
    pub device: String,
    #[serde(flatten)]
    pub op: IntentOp,
    pub at_ms: i64,
}

pub struct IntentLog {
    _path: PathBuf,
}

impl IntentLog {
    pub fn open(path: PathBuf) -> Result<Self, IntentError> {
        Ok(Self { _path: path })
    }

    pub fn record(
        &self,
        _host: HostId,
        _device: DeviceTag,
        _op: IntentOp,
        _now_ms: i64,
    ) -> Result<u64, IntentError> {
        Err(IntentError::Invalid("not implemented".into()))
    }

    pub fn pending(&self) -> Result<Vec<PendingIntent>, IntentError> {
        Ok(Vec::new())
    }

    pub fn mark_applied(&self, _seq: u64, _now_ms: i64) -> Result<(), IntentError> {
        Err(IntentError::Invalid("not implemented".into()))
    }

    pub fn mark_failed(&self, _seq: u64, _reason: &str, _now_ms: i64) -> Result<(), IntentError> {
        Err(IntentError::Invalid("not implemented".into()))
    }
}

pub struct PendingIntent {
    pub seq: u64,
    pub host: HostId,
    pub device: DeviceTag,
    pub install: Option<(EcdsaP256Public, String)>,
    pub attempts: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum IntentError {
    #[error("intent log: {0}")]
    Io(#[from] std::io::Error),
    #[error("intent log: {0}")]
    Invalid(String),
}
