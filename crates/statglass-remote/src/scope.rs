//! Who a connection is and what it may ask (RFC `plan/rfc-ios-app.md` 2.3). A restricted
//! key's forced command writes a preface (`SGSP`, a u16 length, JSON) before the session;
//! the server reads it after Hello. No preface is a full session, so desktop clients are
//! unchanged, and an old server reading one fails closed: `SGSP` as a frame length is
//! above `MAX_WIRE_BYTES`.
use crate::device_keys::DeviceTag;
use serde::Deserialize;
use statglass_proto::Query;
use std::ffi::OsStr;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};

pub use statglass_session::{APP_NOT_RUNNING, MONITORING_OFF};

/// The original SSH commands a restricted key may send.
pub enum RestrictedCommand {
    Serve,
    Version,
    Status,
}

impl RestrictedCommand {
    /// Match the original command literally, including the distinction between no
    /// command and an explicitly empty one.
    pub fn parse(original: Option<&OsStr>) -> Option<Self> {
        match original.map(OsStr::as_encoded_bytes) {
            None | Some(b"serve") => Some(Self::Serve),
            Some(b"version") => Some(Self::Version),
            Some(b"status") => Some(Self::Status),
            _ => None,
        }
    }
}

/// What a connection may ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionScope {
    /// The desktop or a full key: everything.
    Full,
    /// A phone's restricted key: metrics, history and network addresses.
    Restricted { device: DeviceTag },
}

impl SessionScope {
    /// Whether `query` is answered in this scope.
    pub fn allows(&self, query: &Query) -> bool {
        match query {
            Query::History(_) | Query::NetworkAddresses => true,
            Query::UsageByApp { .. }
            | Query::HistoricalUsage(_)
            | Query::UsageProcesses(_)
            | Query::SpaceVolumes
            | Query::SpaceStart { .. }
            | Query::SpaceStatus
            | Query::SpaceCancel
            | Query::SpaceClear
            | Query::SpaceReport
            | Query::SpaceSubtree { .. }
            | Query::SpaceLargestFiles { .. }
            | Query::SpacePath { .. }
            | Query::Unknown => matches!(self, Self::Full),
        }
    }

    /// Advertise this scope on an already connected metrics socket, then bridge stdio.
    pub async fn bridge_stdio(self, mut stream: UnixStream) -> std::io::Result<()> {
        stream.write_all(&encode_preface(&self)).await?;
        crate::stdio::bridge_stream(stream).await
    }
}

/// The first bytes of a session preface.
pub const PREFACE_MAGIC: [u8; 4] = *b"SGSP";
/// The longest preface body a server reads.
pub const MAX_PREFACE_BYTES: usize = 1024;

/// Why a preface was refused. The connection closes before HelloAck.
#[derive(Debug, thiserror::Error)]
pub enum ScopeError {
    #[error("bad session preface: {0}")]
    Preface(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// The preface bytes for `scope`. A full session sends no preface.
pub fn encode_preface(scope: &SessionScope) -> Vec<u8> {
    let SessionScope::Restricted { device } = scope else {
        return Vec::new();
    };
    // DeviceTag displays as six ASCII hex digits and needs no JSON escaping.
    let body = format!(r#"{{"scope":"restricted","device":"{device}"}}"#);
    let mut bytes = Vec::with_capacity(PREFACE_MAGIC.len() + 2 + body.len());
    bytes.extend(PREFACE_MAGIC);
    bytes.extend((body.len() as u16).to_be_bytes());
    bytes.extend(body.bytes());
    bytes
}

#[derive(Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case", deny_unknown_fields)]
enum Preface {
    Restricted { device: DeviceTag },
}

/// Reads a preface if present. Returns the 4 bytes already consumed when they were not the
/// magic, so the frame reader can replay them.
pub async fn read_preface<R: AsyncRead + Unpin>(
    r: &mut R,
) -> Result<(SessionScope, Option<[u8; 4]>), ScopeError> {
    let mut prefix = [0; 4];
    r.read_exact(&mut prefix).await?;
    if prefix != PREFACE_MAGIC {
        return Ok((SessionScope::Full, Some(prefix)));
    }
    let len = usize::from(r.read_u16().await?);
    if len > MAX_PREFACE_BYTES {
        return Err(ScopeError::Preface("length exceeds bounds".into()));
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body).await?;
    let Preface::Restricted { device } =
        serde_json::from_slice(&body).map_err(|error| ScopeError::Preface(error.to_string()))?;
    Ok((SessionScope::Restricted { device }, None))
}
