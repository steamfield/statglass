//! Checks the active route on path changes and promotes a confirmed session.
use super::{
    ControlState, NETWORK_CHANGE_PROBE, RemoteSource, Session, SessionAction, codec, connect,
};
use crate::{
    PROMOTION_DEBOUNCE, RemoteError, Result, Route, SshSession,
    network::{LocalNetwork, UNKNOWN_NETWORK},
};
use statglass_proto::Message;
use std::future::pending;
use tokio::sync::{oneshot, watch};
use tokio::time::{Instant, sleep_until};

// Keep path probes independent of a heartbeat already on the wire.
const PATH_NONCE: u64 = 1 << 63;

#[derive(Default)]
pub(super) struct RouteWatch {
    nonce: u64,
    probe: Option<(u64, Instant)>,
    promotion: Option<Promotion>,
    interrupted_write: bool,
}

struct Promotion {
    result: oneshot::Receiver<Result<SshSession>>,
    _task: codec::AbortOnDrop,
}

impl RouteWatch {
    pub(super) fn probing(&self) -> bool {
        self.probe.is_some()
    }

    pub(super) fn interrupted_write(&self) -> bool {
        self.interrupted_write
    }

    pub(super) async fn next_action(&mut self) -> SessionAction {
        if let Some((_, deadline)) = self.probe {
            sleep_until(deadline).await;
            return SessionAction::Stop;
        }
        let Some(promotion) = &mut self.promotion else {
            return pending().await;
        };
        let result = (&mut promotion.result).await;
        self.promotion = None;
        match result {
            Ok(Ok(session)) => SessionAction::Replace(Box::new(session)),
            _ => SessionAction::Continue,
        }
    }
}

impl RemoteSource {
    /// Reports a path change using the source's local interface probe.
    pub fn network_changed(&self) {
        if let Some(net) = self.probe_network() {
            self.network_changed_with(net);
        } else {
            self.report_network_change(UNKNOWN_NETWORK);
        }
    }

    /// Reports a path change using the caller's snapshot of the local network.
    pub fn network_changed_with(&self, net: LocalNetwork) {
        self.report_network_change(Some(net));
    }

    pub(super) fn report_network_change(&self, net: Option<LocalNetwork>) {
        self.control.send_modify(|state| {
            state.network = state.network.wrapping_add(1);
            state.local_network = net;
        });
    }
}

impl ControlState {
    pub(super) fn route_lost(&self, before: &Self, route: Route) -> bool {
        self.network != before.network
            && self
                .local_network
                .is_some_and(|net| !route_available(route, net))
    }
}

fn route_available(route: Route, net: LocalNetwork) -> bool {
    match route {
        Route::Lan => net.lan_up,
        Route::Tailscale => net.tailscale_up,
    }
}

async fn wait_for_write_interrupt(
    mut control: watch::Receiver<ControlState>,
    mut network: u64,
    mut deadline: Option<Instant>,
) {
    loop {
        tokio::select! {
            biased;
            current = control.wait_for(|state| state.network != network) => {
                let Ok(current) = current else { return; };
                if current.local_network.is_some() {
                    return;
                }
                network = current.network;
                deadline = None;
            }
            () = async {
                match deadline {
                    Some(deadline) => sleep_until(deadline).await,
                    None => pending().await,
                }
            } => return,
        }
    }
}

impl Session<'_> {
    pub(super) async fn write(&mut self, message: &Message) -> Result<()> {
        let deadline = self.route_watch.probe.map(|(_, deadline)| deadline);
        let interrupt = wait_for_write_interrupt(self.control.clone(), self.network, deadline);
        tokio::select! {
            biased;
            result = codec::write(self.writer, message) => result,
            () = interrupt => {
                // A partial frame cannot be followed by a probe on the same stream.
                self.route_watch.interrupted_write = true;
                Err(RemoteError::Transport("remote write interrupted by a path change".into()))
            }
        }
    }

    /// Returns false when the active route is gone and the source should redial now.
    pub(super) async fn check_route(&mut self, next: &ControlState) -> Result<bool> {
        if next.network == self.network {
            return Ok(true);
        }
        self.network = next.network;
        self.route_watch.promotion = None;
        self.route_watch.probe = None;
        let Some(net) = next.local_network else {
            self.promote();
            return Ok(true);
        };
        if !route_available(self.route, net) {
            return Ok(false);
        }
        let nonce = self.route_watch.nonce.wrapping_add(1) | PATH_NONCE;
        self.route_watch.nonce = nonce;
        let deadline = Instant::now() + NETWORK_CHANGE_PROBE;
        self.route_watch.probe = Some((nonce, deadline));
        self.send_ping(nonce).await?;
        Ok(true)
    }

    /// Returns true for every path Pong, including replies to a superseded probe.
    pub(super) fn path_pong(&mut self, nonce: u64) -> bool {
        if nonce & PATH_NONCE == 0 {
            return false;
        }
        if self
            .route_watch
            .probe
            .is_some_and(|(expected, _)| expected == nonce)
        {
            self.route_watch.probe = None;
            self.promote();
        }
        true
    }

    fn promote(&mut self) {
        if let Some(endpoint) = self.source.endpoint.better_than(self.route) {
            let (tx, result) = oneshot::channel();
            let dialer = self.source.dialer.clone();
            let local = self.source.local;
            let expected = self.source.record.id;
            let task = tokio::spawn(async move {
                tokio::time::sleep(PROMOTION_DEBOUNCE).await;
                let result = connect(&*dialer, &endpoint, local, Some(expected)).await;
                let _ = tx.send(result);
            });
            self.route_watch.promotion = Some(Promotion {
                result,
                _task: codec::AbortOnDrop(task),
            });
        }
    }

    async fn send_ping(&mut self, nonce: u64) -> Result<()> {
        self.write(&Message::Ping {
            nonce,
            t0_ms: statglass_engine::wall_ms(),
        })
        .await
    }

    pub(super) async fn send_heartbeat(&mut self) -> Result<()> {
        self.send_ping(self.ping_nonce).await?;
        self.last_ping = Instant::now();
        self.outstanding_ping = Some((self.ping_nonce, self.last_ping));
        self.ping_nonce = self.ping_nonce.wrapping_add(1) & !PATH_NONCE;
        Ok(())
    }
}
