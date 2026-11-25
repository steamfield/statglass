//! Host-side remote queries (D-117). Answers run on the blocking pool beside live frames.
use crate::codec;
use crate::history_query::limits::busy;
use crate::server::ServerProvider;
use statglass_proto::{Answer, ErrorCode, HistoryQuery, Message, Query};
use statglass_schema::{Labels, MetricId, lock::LockExt};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::mpsc;

/// Per-session admission limit for immediate answers and depth limit for waiting history.
pub(crate) const MAX_IN_FLIGHT: usize = 8;

/// Host side: the session's queries being answered. Each task holds `keep`, so the
/// session's end reaches the provider only after its last answer is done: a scan started
/// by a query that finishes after the connection dropped is still released.
pub(crate) struct Answering {
    provider: Arc<dyn ServerProvider>,
    session: u64,
    keep: Arc<dyn Send + Sync>,
    done: mpsc::Sender<Vec<u8>>,
    /// Queries that change state (start, cancel, clear a scan), answered one at a time in
    /// the order they came, so a clear sent before a start never cancels it.
    ordered: mpsc::UnboundedSender<(u32, Query)>,
    history: Arc<Mutex<HistoryQueue>>,
    in_flight: usize,
}

#[derive(Default)]
struct HistoryQueue {
    running: bool,
    waiting: VecDeque<PendingHistory>,
}

struct PendingHistory {
    id: u32,
    query: HistoryQuery,
    selectors: Vec<(MetricId, Labels)>,
}

impl PendingHistory {
    fn new(id: u32, query: HistoryQuery) -> Self {
        let mut selectors: Vec<_> = query
            .series
            .iter()
            .map(|selector| (selector.metric.clone(), selector.labels.clone()))
            .collect();
        selectors.sort_unstable();
        selectors.dedup();
        Self {
            id,
            query,
            selectors,
        }
    }

    fn same_chart(&self, other: &Self) -> bool {
        self.query.max_points == other.query.max_points && self.selectors == other.selectors
    }
}

impl Answering {
    /// The answering side and where its encoded replies arrive, for the session loop to
    /// write. `keep` lives until every answer started here is done.
    pub(crate) fn new(
        provider: Arc<dyn ServerProvider>,
        session: u64,
        keep: Arc<dyn Send + Sync>,
    ) -> (Self, mpsc::Receiver<Vec<u8>>) {
        let (done, replies) = mpsc::channel(MAX_IN_FLIGHT);
        let (ordered, mut queue) = mpsc::unbounded_channel::<(u32, Query)>();
        let (lane, lane_done, lane_keep) = (provider.clone(), done.clone(), keep.clone());
        tokio::spawn(async move {
            let _keep = lane_keep;
            while let Some((id, query)) = queue.recv().await {
                let reply = answer(lane.clone(), session, id, query).await;
                let _ = lane_done.send(reply).await;
            }
        });
        let answering = Self {
            provider,
            session,
            keep,
            done,
            ordered,
            history: Arc::default(),
            in_flight: 0,
        };
        (answering, replies)
    }

    /// Starts answering `query`, or returns the busy reply to send at once.
    pub(crate) fn start(&mut self, id: u32, query: Query) -> Option<Message> {
        if let Query::History(history) = query {
            return self.start_history(id, history);
        }
        // Waiting history has its own bound and takes no slots from other queries.
        if self.in_flight - self.history.lock_ok().waiting.len() >= MAX_IN_FLIGHT {
            return Some(busy_reply(id));
        }
        self.in_flight += 1;
        if matches!(
            query,
            Query::SpaceStart { .. } | Query::SpaceCancel | Query::SpaceClear
        ) {
            // The lane task lives as long as `self`, which holds its sender.
            let _ = self.ordered.send((id, query));
            return None;
        }
        let (provider, done, keep) = (self.provider.clone(), self.done.clone(), self.keep.clone());
        let session = self.session;
        tokio::spawn(async move {
            let _keep = keep;
            let reply = answer(provider, session, id, query).await;
            let _ = done.send(reply).await;
        });
        None
    }

    fn start_history(&mut self, id: u32, query: HistoryQuery) -> Option<Message> {
        let mut queue = self.history.lock_ok();
        if queue.running {
            let pending = PendingHistory::new(id, query);
            let superseded = queue
                .waiting
                .iter()
                .position(|older| pending.same_chart(older))
                .and_then(|position| queue.waiting.remove(position));
            if queue.waiting.len() >= MAX_IN_FLIGHT {
                return Some(busy_reply(id));
            }
            queue.waiting.push_back(pending);
            if let Some(older) = superseded {
                return Some(busy_reply(older.id));
            }
        } else {
            if self.in_flight >= MAX_IN_FLIGHT {
                return Some(busy_reply(id));
            }
            queue.running = true;
            let (provider, done, keep) =
                (self.provider.clone(), self.done.clone(), self.keep.clone());
            let waiting = Arc::downgrade(&self.history);
            let session = self.session;
            tokio::spawn(async move {
                let _keep = keep;
                run_history(provider, session, done, waiting, id, query).await;
            });
        }
        self.in_flight += 1;
        None
    }

    /// A reply arrived and is being written.
    pub(crate) fn finished(&mut self) {
        self.in_flight = self.in_flight.saturating_sub(1);
    }
}

async fn run_history(
    provider: Arc<dyn ServerProvider>,
    session: u64,
    done: mpsc::Sender<Vec<u8>>,
    waiting: Weak<Mutex<HistoryQueue>>,
    mut id: u32,
    mut query: HistoryQuery,
) {
    loop {
        let reply = answer(provider.clone(), session, id, Query::History(query)).await;
        if done.send(reply).await.is_err() {
            return;
        }
        // Only the connection owns the waiting requests. Disconnect drops them.
        let Some(waiting) = waiting.upgrade() else {
            return;
        };
        let mut queue = waiting.lock_ok();
        let Some(next) = queue.waiting.pop_front() else {
            queue.running = false;
            return;
        };
        (id, query) = (next.id, next.query);
    }
}

fn busy_reply(id: u32) -> Message {
    Message::Reply { id, answer: busy() }
}

/// Answers on the blocking pool and encodes the reply frame there, with an error in its
/// place when the answer would not fit in a frame.
async fn answer(provider: Arc<dyn ServerProvider>, session: u64, id: u32, query: Query) -> Vec<u8> {
    let permit = if matches!(query, Query::History(_))
        && let Some(limits) = provider.history_limits()
    {
        let Ok(permit) = limits.try_acquire() else {
            return statglass_proto::encode_frame(&busy_reply(id)).unwrap_or_default();
        };
        Some(permit)
    } else {
        None
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let answer = provider.answer(session, query);
        let frame = statglass_proto::encode_frame(&Message::Reply { id, answer })
            .ok()
            .filter(|bytes| bytes.len() <= codec::MAX_WIRE_BYTES + 4);
        frame.unwrap_or_else(|| failed(id, "The answer exceeds the transport limit"))
    })
    .await
    .unwrap_or_else(|e| failed(id, &e.to_string()))
}

/// The encoded error reply for `id`.
fn failed(id: u32, message: &str) -> Vec<u8> {
    let reply = Message::Reply {
        id,
        answer: error(message),
    };
    // A short error reply always encodes.
    statglass_proto::encode_frame(&reply).unwrap_or_default()
}

fn error(message: &str) -> Answer {
    Answer::Error {
        code: ErrorCode::Internal,
        message: message.into(),
    }
}
