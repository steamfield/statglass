//! Host-side remote queries (D-117). Answers run on the blocking pool beside live frames.
use crate::codec;
use crate::server::ServerProvider;
use statglass_proto::{Answer, ErrorCode, Message, Query};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Queries one host session answers at once; more are refused as busy.
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
    in_flight: usize,
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
            in_flight: 0,
        };
        (answering, replies)
    }

    /// Starts answering `query`, or returns the busy reply to send at once.
    pub(crate) fn start(&mut self, id: u32, query: Query) -> Option<Message> {
        if self.in_flight >= MAX_IN_FLIGHT {
            return Some(Message::Reply {
                id,
                answer: Answer::Error {
                    code: ErrorCode::Busy,
                    message: "The host is busy with other requests".into(),
                },
            });
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

    /// A reply arrived and is being written.
    pub(crate) fn finished(&mut self) {
        self.in_flight = self.in_flight.saturating_sub(1);
    }
}

/// Answers on the blocking pool and encodes the reply frame there, with an error in its
/// place when the answer would not fit in a frame.
async fn answer(provider: Arc<dyn ServerProvider>, session: u64, id: u32, query: Query) -> Vec<u8> {
    tokio::task::spawn_blocking(move || {
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
