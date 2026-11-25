//! Bounded chart history served by the monitored host.

use crate::{HostServer, ServedHost};
use statglass_proto::{Answer, HistoryQuery};

#[cfg(test)]
#[path = "../tests/support/history_seed.rs"]
mod history_seed;
pub mod limits;
mod read;
use limits::HistoryGrid;

pub const HISTORY_MAX_POINTS: u32 = 500;
pub const HISTORY_MAX_SERIES: usize = 32;
pub const HISTORY_MAX_CORE_SERIES: usize = 256;
pub const HISTORY_MAX_EVENTS: usize = 200;
pub const HISTORY_MAX_ANSWER_BYTES: usize = 512 * 1024;

pub(crate) fn answer<H: ServedHost>(
    server: &HostServer<H>,
    query: &HistoryQuery,
) -> (Answer, Option<HistoryGrid>) {
    read::answer(server, query)
}
