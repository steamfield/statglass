//! Client-side remote queries (D-117): send requests and match replies to callers by id.
use crate::{RemoteError, Result};
use statglass_proto::{Answer, Message, Query};
use statglass_schema::lock::LockExt;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// A query from the controller, and where its answer goes.
pub(crate) struct Call {
    query: Query,
    answer: oneshot::Sender<Answer>,
}

/// The controller's way to its host's current session.
#[derive(Default)]
pub(crate) enum Line {
    #[default]
    Down,
    /// Connected to a host that does not answer queries (no `query.v1`).
    Old,
    Up {
        calls: mpsc::Sender<Call>,
        usage_history: bool,
    },
}

/// Calls a session takes at once before the caller is told to back off.
const QUEUED: usize = 16;

/// Asks the host on `line` and waits up to `timeout` for its answer. An
/// `Answer::Error` is the host's own refusal; connection failures and a host too busy or
/// slow to answer are errors.
pub(crate) async fn call(line: &Mutex<Line>, query: Query, timeout: Duration) -> Result<Answer> {
    let durable = matches!(&query, Query::HistoricalUsage(_) | Query::UsageProcesses(_));
    let calls = match &*line.lock_ok() {
        Line::Up {
            usage_history: false,
            ..
        }
        | Line::Old
            if durable =>
        {
            return Err(RemoteError::Unsupported(
                "This host does not support usage history; update StatGlass on that host".into(),
            ));
        }
        Line::Up { calls, .. } => calls.clone(),
        Line::Old => {
            return Err(RemoteError::Incompatible(
                "this host's StatGlass is too old to answer; update it".into(),
            ));
        }
        Line::Down => return Err(RemoteError::Transport("the host is not connected".into())),
    };
    let (answer, answered) = oneshot::channel();
    calls
        .try_send(Call { query, answer })
        .map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => {
                RemoteError::Busy("too many requests to the host".into())
            }
            mpsc::error::TrySendError::Closed(_) => disconnected(),
        })?;
    match tokio::time::timeout(timeout, answered).await {
        Ok(Ok(answer)) => Ok(answer),
        Ok(Err(_)) => Err(disconnected()),
        Err(_) => Err(RemoteError::Busy("the host did not answer in time".into())),
    }
}

fn disconnected() -> RemoteError {
    RemoteError::Transport("the host disconnected".into())
}

/// Opens `line` for one session, which takes calls from the returned receiver. Dropping
/// the guard puts the line down; calls still queued or pending then fail as disconnected.
pub(crate) fn open(
    line: &Mutex<Line>,
    answers: bool,
    usage_history: bool,
) -> (LineGuard<'_>, mpsc::Receiver<Call>) {
    let (calls, queued) = mpsc::channel(QUEUED);
    *line.lock_ok() = if answers {
        Line::Up {
            calls,
            usage_history,
        }
    } else {
        Line::Old
    };
    (LineGuard(line), queued)
}

pub(crate) struct LineGuard<'a>(&'a Mutex<Line>);

impl Drop for LineGuard<'_> {
    fn drop(&mut self) {
        *self.0.lock_ok() = Line::Down;
    }
}

/// Controller side: one session's calls awaiting a reply.
#[derive(Default)]
pub(crate) struct Pending {
    next_id: u32,
    waiting: HashMap<u32, oneshot::Sender<Answer>>,
}

impl Pending {
    /// The request to send for `call`.
    pub(crate) fn request(&mut self, call: Call) -> Message {
        // A caller that gave up still gets its reply from the host; forget it now.
        self.waiting.retain(|_, answer| !answer.is_closed());
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.waiting.insert(id, call.answer);
        Message::Request {
            id,
            query: call.query,
        }
    }

    /// Hands a reply to its caller; a reply nobody waits for is dropped.
    pub(crate) fn reply(&mut self, id: u32, answer: Answer) {
        if let Some(waiting) = self.waiting.remove(&id) {
            let _ = waiting.send(answer);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(limit: u32) -> Query {
        Query::UsageByApp {
            from_ms: 0,
            to_ms: 1,
            by: statglass_schema::usage::UsageKey::Cpu,
            limit,
        }
    }

    const WAIT: Duration = Duration::from_secs(5);

    fn path(answer: Result<Answer>) -> String {
        match answer {
            Ok(Answer::SpacePath(text)) => text,
            other => panic!("expected a path, got {other:?}"),
        }
    }

    fn historical() -> Query {
        Query::HistoricalUsage(statglass_schema::durable_usage::HistoricalUsageRequest {
            host: statglass_schema::HostId(uuid::Uuid::nil()),
            from_ms: 0,
            to_ms: 60000,
            by: statglass_schema::durable_usage::HistoricalUsageMetric::Cpu,
            app_names: Vec::new(),
        })
    }

    #[tokio::test]
    async fn durable_queries_require_negotiated_support_and_never_fall_back_offline() {
        let line = Mutex::new(Line::Down);
        assert!(matches!(
            call(&line, historical(), WAIT).await,
            Err(RemoteError::Transport(_))
        ));
        let (old, queued) = open(&line, false, false);
        assert!(matches!(
            call(&line, historical(), WAIT).await,
            Err(RemoteError::Unsupported(_))
        ));
        drop((old, queued));
        let (guard, mut queued) = open(&line, true, false);
        assert!(matches!(
            call(&line, historical(), WAIT).await,
            Err(RemoteError::Unsupported(_))
        ));
        assert!(queued.try_recv().is_err());
        let (ordinary, ()) = tokio::join!(call(&line, usage(1), WAIT), async {
            let call = queued.recv().await.unwrap();
            call.answer.send(Answer::Done).unwrap();
        });
        assert_eq!(ordinary.unwrap(), Answer::Done);
        drop((guard, queued));
        let (guard, mut queued) = open(&line, true, true);
        let (durable, ()) = tokio::join!(call(&line, historical(), WAIT), async {
            let call = queued.recv().await.unwrap();
            assert_eq!(call.query, historical());
            call.answer.send(Answer::Done).unwrap();
        });
        assert_eq!(durable.unwrap(), Answer::Done);
        drop((guard, queued));
        assert!(matches!(
            call(&line, historical(), WAIT).await,
            Err(RemoteError::Transport(_))
        ));
    }

    /// Replies reach their own callers in any order; a reply for nobody is dropped.
    #[tokio::test]
    async fn replies_reach_their_callers_out_of_order() {
        let line = Mutex::new(Line::Down);
        let (_guard, mut queued) = open(&line, true, true);
        let session = async {
            let mut pending = Pending::default();
            let mut ids = Vec::new();
            for _ in 0..2 {
                let Message::Request { id, query } = pending.request(queued.recv().await.unwrap())
                else {
                    panic!("expected a request")
                };
                ids.push((id, query));
            }
            assert!(matches!(ids[0].1, Query::UsageByApp { limit: 1, .. }));
            assert_ne!(ids[0].0, ids[1].0);
            pending.reply(ids[0].0.wrapping_add(100), Answer::Done);
            pending.reply(ids[1].0, Answer::SpacePath("second".into()));
            pending.reply(ids[0].0, Answer::SpacePath("first".into()));
        };
        let (first, second, ()) = tokio::join!(
            call(&line, usage(1), WAIT),
            call(&line, usage(2), WAIT),
            session
        );
        assert_eq!(path(first), "first");
        assert_eq!(path(second), "second");
    }

    /// Calls fail at once when no session is up or the host is too old, and every call
    /// still waiting fails when its session ends, sent or not.
    #[tokio::test]
    async fn calls_fail_when_the_session_is_down_old_or_ends() {
        let line = Mutex::new(Line::Down);
        assert!(matches!(
            call(&line, usage(1), WAIT).await,
            Err(RemoteError::Transport(_))
        ));
        drop(open(&line, false, false));
        assert!(matches!(&*line.lock_ok(), Line::Down));
        let (guard, queued) = open(&line, false, false);
        assert!(matches!(
            call(&line, usage(1), WAIT).await,
            Err(RemoteError::Incompatible(_))
        ));
        drop((guard, queued));

        let (guard, mut queued) = open(&line, true, true);
        let session = async {
            let mut pending = Pending::default();
            let _sent = pending.request(queued.recv().await.unwrap());
            tokio::task::yield_now().await;
            drop((pending, queued, guard));
        };
        let (sent, unsent, ()) = tokio::join!(
            call(&line, usage(1), WAIT),
            call(&line, usage(2), WAIT),
            session
        );
        for failed in [sent, unsent] {
            assert!(
                matches!(&failed, Err(RemoteError::Transport(m)) if m.contains("disconnected")),
                "{failed:?}"
            );
        }
        assert!(matches!(&*line.lock_ok(), Line::Down));
    }

    /// A host that never answers times the caller out, and the abandoned call is
    /// forgotten when the next one is sent.
    #[tokio::test(start_paused = true)]
    async fn an_unanswered_call_times_out_and_is_forgotten() {
        let line = Mutex::new(Line::Down);
        let (_guard, mut queued) = open(&line, true, true);
        let mut pending = Pending::default();
        let (late, ()) = tokio::join!(call(&line, usage(1), Duration::from_secs(10)), async {
            let _ = pending.request(queued.recv().await.unwrap());
        });
        assert!(
            matches!(&late, Err(RemoteError::Busy(m)) if m.contains("in time")),
            "{late:?}"
        );
        let (answered, ()) = tokio::join!(call(&line, usage(2), WAIT), async {
            let Message::Request { id, .. } = pending.request(queued.recv().await.unwrap()) else {
                panic!("expected a request")
            };
            assert_eq!(pending.waiting.len(), 1);
            pending.reply(id, Answer::SpacePath("on time".into()));
        });
        assert_eq!(path(answered), "on time");
    }
}
