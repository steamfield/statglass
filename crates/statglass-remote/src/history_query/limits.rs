use std::time::Duration;

use statglass_proto::{Answer, HistoryQuery};

pub const HISTORY_MAX_CONCURRENT: usize = 2;
pub const HISTORY_CACHE_TTL: Duration = Duration::from_secs(10);

/// Per-host query limits and cache. Reads currently run without either.
#[derive(Default)]
pub struct HistoryLimits {
    _private: (),
}

impl HistoryLimits {
    pub(crate) fn answer(
        &self,
        query: &HistoryQuery,
        read: impl FnOnce(&HistoryQuery) -> Answer,
    ) -> Answer {
        read(query)
    }
}
