//! The behavior every [`Dialer`] must show against a live host running the StatGlass
//! agent. The OpenSSH and russh dialers run it in their Docker tests.
use crate::{Dialer, Endpoint, Mirror, RemoteError, RemoteSource, SshSession, codec, connect};
use statglass_engine::{HistoryStore, Source, SourceSink, wall_ms};
use statglass_proto::{Message, RemoteInterest, SyncRequest};
use statglass_schema::{HostId, HostRecord, Tier};
use std::{sync::Arc, time::Duration};
use tokio::{sync::watch, time::timeout};

const LIVE_TIMEOUT: Duration = Duration::from_secs(15);
const SYNC_TIMEOUT: Duration = Duration::from_secs(60);
// A cold agent closes its first full M1 bucket up to two minutes after it starts: the
// partial first minute, then a whole one.
const HISTORY_READY_TIMEOUT: Duration = Duration::from_secs(180);

/// A live host to run the suite against.
pub struct ConformanceHost {
    /// Reaches the host with its agent running.
    pub endpoint: Endpoint,
    /// Reaches the same host but starts the agent against a socket nothing serves.
    pub stopped: Endpoint,
    /// The agent's host id.
    pub host_id: HostId,
}

/// A session opens, identifies the host, streams live data and answers a ping.
pub async fn live_session(dialer: &dyn Dialer, host: &ConformanceHost) {
    let mut session = connect(dialer, &host.endpoint, local_id(), Some(host.host_id))
        .await
        .expect("connect to the running agent");
    assert_eq!(session.hello.host.id, host.host_id);
    timeout(LIVE_TIMEOUT, wait_for_live(&mut session))
        .await
        .expect("receive a layout and its live frame within 15 seconds")
        .expect("exchange live messages");

    let t0_ms = wall_ms();
    let nonce = 1;
    timeout(LIVE_TIMEOUT, async {
        codec::write(&mut session.writer, &Message::Ping { nonce, t0_ms }).await?;
        loop {
            if let Message::Pong {
                nonce: reply,
                t0_ms: sent,
                ..
            } = codec::read(&mut session.reader).await?
            {
                assert_eq!((reply, sent), (nonce, t0_ms));
                return Ok::<_, RemoteError>(());
            }
        }
    })
    .await
    .expect("receive a Pong within 15 seconds")
    .expect("exchange heartbeat messages");
    session.close().await;
}

async fn wait_for_live(session: &mut SshSession) -> crate::Result<()> {
    codec::write(
        &mut session.writer,
        &Message::Interest(RemoteInterest {
            detail: true,
            ..Default::default()
        }),
    )
    .await?;
    let mut layout = None;
    loop {
        match codec::read(&mut session.reader).await? {
            Message::LayoutDef(definition) => layout = Some(definition.layout_no),
            Message::Live(frame) => {
                assert_eq!(
                    layout,
                    Some(frame.layout_no),
                    "the layout must precede its live frame"
                );
                return Ok(());
            }
            _ => {}
        }
    }
}

/// A host whose agent is stopped reads as `AgentNotRunning`.
pub async fn agent_not_running(dialer: &dyn Dialer, host: &ConformanceHost) {
    match connect(dialer, &host.stopped, local_id(), Some(host.host_id)).await {
        Err(RemoteError::AgentNotRunning(_)) => {}
        Err(error) => panic!("expected AgentNotRunning, got {error:?}"),
        Ok(session) => {
            session.close().await;
            panic!("connected to the stopped agent");
        }
    }
}

/// A `RemoteSource` connects and advances its mirror's sync cursor.
pub async fn source_syncs_mirror(dialer: Arc<dyn Dialer>, host: &ConformanceHost) {
    let local = local_id();
    let mut session = connect(&*dialer, &host.endpoint, local, Some(host.host_id))
        .await
        .expect("read the running agent's mirror identity");
    let record = HostRecord::from_identity(session.hello.host.clone(), false);
    let epoch = session.hello.db_instance_uuid;
    let kinds = session.negotiated.sync_kinds();
    // A fresh agent needs up to a minute to close its first M1 bucket.
    timeout(HISTORY_READY_TIMEOUT, wait_for_minute_history(&mut session))
        .await
        .expect("the agent must export minute history before the mirror test starts")
        .expect("read the agent's minute history");
    session.close().await;

    let dir = tempfile::tempdir().expect("create a temporary mirror directory");
    let history = Arc::new(HistoryStore::open(dir.path()));
    assert!(
        history.register_host(&record).is_some(),
        "register the mirror host"
    );
    let mirror = Arc::new(Mirror::new(history.clone(), record.id, 100));
    let cursor = || {
        history
            .read(|r| r.resume_cursor(host.host_id, Tier::M1, epoch, kinds))
            .expect("read the mirror's minute cursor")
    };
    assert!(cursor().is_none(), "the mirror starts empty");
    let (status_tx, status_rx) = watch::channel(crate::ConnectionStatus::default());
    let source = RemoteSource::new(
        record,
        local,
        dialer,
        host.endpoint.clone(),
        Arc::new(move |status| {
            status_tx.send_replace(status);
        }),
        Some(mirror),
    );
    let mut handle = source
        .start(SourceSink {
            live: Default::default(),
            store: None,
        })
        .expect("start the remote source");
    let synced = timeout(SYNC_TIMEOUT, async {
        let mut poll = tokio::time::interval(Duration::from_millis(100));
        loop {
            poll.tick().await;
            let connected = status_rx.borrow().connected;
            if connected && cursor().is_some_and(|c| c.seq > 0) {
                break;
            }
        }
    })
    .await;
    let last_status = status_rx.borrow().clone();
    handle.stop();
    assert!(
        synced.is_ok(),
        "the source must connect and advance its M1 cursor within 60 seconds, last status: {last_status:?}"
    );
}

async fn wait_for_minute_history(session: &mut SshSession) -> crate::Result<()> {
    let request = Message::SyncRequest(SyncRequest {
        tier: Tier::M1,
        after: None,
        max_rows: 1,
        from_ms: None,
        max_bytes: None,
    });
    let mut poll = tokio::time::interval(Duration::from_secs(1));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        poll.tick().await;
        codec::write(&mut session.writer, &request).await?;
        loop {
            match codec::read(&mut session.reader).await? {
                Message::SyncPage(page) if page.tier == Tier::M1 => {
                    if page.last_seq > 0 {
                        return Ok(());
                    }
                    break;
                }
                Message::Error { message, .. } => {
                    return Err(RemoteError::HistoryUnavailable(message));
                }
                _ => {}
            }
        }
    }
}

fn local_id() -> HostId {
    HostId(uuid::Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::fixture_hello;
    use statglass_proto::{SyncPage, WireBucket, WireLayout};
    use statglass_schema::SeriesKey;

    #[tokio::test(start_paused = true)]
    async fn mirror_waits_for_a_cold_host_to_export_minute_history() {
        let hello = fixture_hello();
        let epoch = hello.db_instance_uuid;
        let (client, mut host) = tokio::io::duplex(65536);
        let mut session = SshSession::test(client, hello);
        let peer = async {
            let mut page = SyncPage {
                tier: Tier::M1,
                epoch,
                layouts: Vec::new(),
                rows: Vec::new(),
                gaps: Vec::new(),
                events: Vec::new(),
                last_seq: 0,
                more: false,
            };
            for attempt in 0..2 {
                let request = codec::read(&mut host)
                    .await
                    .expect("request minute history");
                assert!(matches!(
                    request,
                    Message::SyncRequest(r) if r.tier == Tier::M1 && r.after.is_none()
                ));
                if attempt == 1 {
                    page.layouts.push(WireLayout {
                        layout_no: 0,
                        series: vec![SeriesKey::parse("cpu.total").unwrap()],
                    });
                    page.rows.push(WireBucket {
                        seq: 1,
                        bucket_ts: 0,
                        layout_no: 0,
                        stats: vec![1., 3., 2.],
                    });
                    page.last_seq = 1;
                }
                codec::write(&mut host, &Message::SyncPage(page.clone()))
                    .await
                    .unwrap();
            }
        };
        timeout(Duration::from_secs(3), async {
            let (ready, ()) = tokio::join!(wait_for_minute_history(&mut session), peer);
            ready.expect("the retry sees the first minute of history");
        })
        .await
        .expect("retry the empty M1 page before declaring the host ready");
    }
}
