use crate::{HostServer, ServedHost};
use statglass_proto::{Answer, ErrorCode, HistoryQuery};

use super::HistoryGrid;

pub(super) fn answer<H: ServedHost>(
    _server: &HostServer<H>,
    _query: &HistoryQuery,
) -> (Answer, Option<HistoryGrid>) {
    (
        Answer::Error {
            code: ErrorCode::Unsupported,
            message: "This host does not answer history queries".into(),
        },
        None,
    )
}
