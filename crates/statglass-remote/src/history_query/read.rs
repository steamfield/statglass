use crate::{HostServer, ServedHost};
use statglass_proto::{Answer, ErrorCode, HistoryQuery};
use statglass_schema::Tier;

use super::HistoryGrid;

pub(super) fn answer<H: ServedHost>(
    _server: &HostServer<H>,
    query: &HistoryQuery,
    grid: &mut Option<HistoryGrid>,
) -> Answer {
    *grid = query
        .to_ms
        .and_then(|to| HistoryGrid::for_tier(Tier::S10, query.from_ms, to));
    Answer::Error {
        code: ErrorCode::Unsupported,
        message: "This host does not answer history queries".into(),
    }
}
