//! Who a connection is and what it may ask (RFC `plan/rfc-ios-app.md` 2.3). A restricted
//! key's forced command writes a preface (`SGSP`, a u16 length, JSON) before the session;
//! the server reads it after Hello. No preface is a full session, so desktop clients are
//! unchanged, and an old server reading one fails closed: `SGSP` as a frame length is
//! above `MAX_WIRE_BYTES`.
//!
//! Scaffold: phase 5 lane a implements the preface and the exhaustive query allowlist.
use crate::device_keys::DeviceTag;
use tokio::io::AsyncRead;

/// What a connection may ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionScope {
    /// The desktop or a full key: everything.
    Full,
    /// A phone's restricted key: live metrics, sync, recent rows and events, no `Query`.
    Restricted { device: DeviceTag },
}

impl SessionScope {
    /// Whether `query` is answered in this scope. Scaffold stub: only a full session
    /// allows anything, until phase 5 lane a writes the exhaustive match.
    pub fn allows(&self, query: &statglass_proto::Query) -> bool {
        let _ = query;
        matches!(self, Self::Full)
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

/// The preface bytes for `scope`. Scaffold stub: empty (a full session) until phase 5
/// lane a.
pub fn encode_preface(scope: &SessionScope) -> Vec<u8> {
    let _ = scope;
    Vec::new()
}

/// Reads a preface if present. Returns the 4 bytes already consumed when they were not the
/// magic, so the frame reader can replay them. Scaffold stub: a refusal until phase 5
/// lane a; nothing calls it yet.
pub async fn read_preface<R: AsyncRead + Unpin>(
    r: &mut R,
) -> Result<(SessionScope, Option<[u8; 4]>), ScopeError> {
    let _ = r;
    Err(ScopeError::Preface("not implemented".into()))
}
