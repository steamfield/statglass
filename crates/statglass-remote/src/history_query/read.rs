use crate::{HostServer, ServedHost};
use statglass_proto::{Answer, ErrorCode, HistoryQuery};

pub(super) fn answer<H: ServedHost>(_server: &HostServer<H>, _query: &HistoryQuery) -> Answer {
    Answer::Error {
        code: ErrorCode::Unsupported,
        message: "This host does not answer history queries".into(),
    }
}
