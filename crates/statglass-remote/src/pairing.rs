//! The host side of pairing (RFC `plan/rfc-ios-app.md` 2.4): offer a one-time pairing
//! key, bind it to the first `PairStart`, and complete only when the host's approver
//! says so. Also the forced `pair` command every host runs for the phone.
use crate::device_keys::{DeviceKeys, DeviceKeysError, DeviceTag, EcdsaP256Public};
use crate::{ControlRequest, ControlResponse, command::shell_quote};
use p256::elliptic_curve::{Generate, sec1::ToSec1Point};
use statglass_proto::handover::UnavailableHost;
use statglass_proto::pairing::{
    BundleHost, CODE_ALPHABET, PAYLOAD_VERSION, PairError, PairReply, PairStart, PairingPayload,
    encode_pair_frame,
};
use statglass_schema::lock::LockExt;
use std::{
    collections::HashMap,
    io,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

mod helper_link;
mod relay;
pub use helper_link::{ensure_helper_link, link_helper};
pub use relay::{run_forced, run_forced_for_nonce};

/// The `command=` prefixes for the lines pairing installs; the nonce or device tag is
/// appended.
pub struct PairCommands {
    /// The forced `pair` command, before `--nonce <n>`.
    pub pair: String,
    /// The forced restricted command, before `--device <tag>`.
    pub restricted: String,
}

impl PairCommands {
    pub fn for_helper(link: &Path) -> io::Result<Self> {
        let command = shell_quote(link.to_str().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "the SSH helper path is not UTF-8",
            )
        })?);
        Ok(Self {
            pair: format!("{command} pair"),
            restricted: format!("{command} restricted"),
        })
    }

    pub fn restricted_for(&self, tag: DeviceTag) -> String {
        format!("{} --device {tag}", self.restricted)
    }
}

pub struct Handover {
    pub hosts: Vec<BundleHost>,
    pub unavailable: Vec<UnavailableHost>,
}

/// The handover source's result and whether the phone received a local-only reply.
pub struct HandoverSummary {
    pub handover: Handover,
    pub dropped: bool,
}

/// A reply and its host-side handover summary, captured together.
pub type PairOutcome = (PairReply, Option<Arc<HandoverSummary>>);

pub trait HandoverSource: Send + Sync {
    fn handover(&self, device: DeviceTag, key: &EcdsaP256Public, name: &str) -> Handover;
}

/// Why the host could not offer or decide a pairing.
#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error(transparent)]
    Keys(#[from] DeviceKeysError),
    #[error("{0}")]
    Pair(#[from] PairError),
    #[error("StatGlass is quitting.")]
    Closing,
}

/// Every open pairing offer on this host and the keys it edits.
pub struct PairingHost {
    keys: Arc<dyn DeviceKeys>,
    commands: PairCommands,
    state: Mutex<HostState>,
    handover: Mutex<Option<Arc<dyn HandoverSource>>>,
}

#[derive(Default)]
struct HostState {
    offers: HashMap<String, Offer>,
    closing: bool,
}

struct Offer {
    host: BundleHost,
    code: String,
    expires_ms: i64,
    attempt: Option<[u8; 16]>,
    phase: Phase,
}

enum Phase {
    Offered {
        pairing_key: EcdsaP256Public,
    },
    Pending {
        device_name: String,
        model: String,
        key: EcdsaP256Public,
    },
    HandingOver,
    RemovingPairingLine(PairOutcome),
    Finished(PairOutcome),
}

const DEFAULT_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_TTL: Duration = Duration::from_secs(60 * 60);
const RECEIPT_MS: i64 = 10 * 60 * 1000;

impl PairingHost {
    /// A host that edits `keys` and forces `commands`.
    pub fn new(keys: Arc<dyn DeviceKeys>, commands: PairCommands) -> Self {
        Self {
            keys,
            commands,
            state: Mutex::default(),
            handover: Mutex::default(),
        }
    }

    pub fn set_handover(&self, source: Arc<dyn HandoverSource>) {
        *self.handover.lock_ok() = Some(source);
    }

    /// Installs a pairing line for `host` valid for `ttl` and returns the QR payload.
    /// A zero `ttl` uses the default of 10 minutes.
    pub fn offer(
        &self,
        host: BundleHost,
        ttl: Duration,
        now_ms: i64,
    ) -> Result<PairingPayload, PairingError> {
        let ttl = if ttl.is_zero() { DEFAULT_TTL } else { ttl };
        if ttl > MAX_TTL {
            return Err(PairError::Invalid.into());
        }
        let ttl_ms = i64::try_from(ttl.as_millis()).map_err(|_| PairError::Invalid)?;
        let expires_ms = now_ms
            .checked_add(ttl_ms)
            .filter(|&expiry| expiry > now_ms)
            .ok_or(PairError::Invalid)?;
        let key = p256::SecretKey::try_generate().map_err(entropy_error)?;
        let nonce: String = <[u8; 16]>::try_generate()
            .map_err(entropy_error)?
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let code = make_code()?;
        let point = key.public_key().to_sec1_point(false);
        let public = EcdsaP256Public(
            point
                .as_bytes()
                .try_into()
                .map_err(|_| PairError::Invalid)?,
        );
        let command = format!("{} --nonce {nonce}", self.commands.pair);
        let mut state = self.state.lock_ok();
        if state.closing {
            return Err(PairingError::Closing);
        }
        if state.offers.contains_key(&nonce) {
            return Err(PairError::Unavailable.into());
        }
        self.keys
            .add_pairing(&public, &nonce, expires_ms, &command)?;
        state.offers.insert(
            nonce.clone(),
            Offer {
                host: host.clone(),
                code: code.clone(),
                expires_ms,
                attempt: None,
                phase: Phase::Offered {
                    pairing_key: public,
                },
            },
        );
        Ok(PairingPayload {
            version: PAYLOAD_VERSION,
            host,
            pairing_key: key.to_bytes().into(),
            nonce,
            code,
            expires_ms,
            can_hand_over: self.handover.lock_ok().is_some(),
        })
    }

    fn start_inner(
        &self,
        req: &PairStart,
        attempt: [u8; 16],
        now_ms: i64,
    ) -> (PairReply, Option<i64>) {
        let mut state = self.state.lock_ok();
        let Some(offer) = state.offers.get_mut(&req.nonce) else {
            return (reject(PairError::Unknown), None);
        };
        offer.refresh(self.keys.as_ref(), &req.nonce, now_ms);
        let reply = offer.start(req, attempt);
        let expires = (reply == PairReply::Waiting).then_some(offer.expires_ms);
        (reply, expires)
    }

    /// Answers pairing requests from the owner-only control socket. The accepted
    /// start includes the host's expiry in JSON, alongside the phone's wire reply.
    pub fn control_reply(&self, request: ControlRequest, now_ms: i64) -> ControlResponse {
        let (reply, pairing_expires_ms) = match request {
            ControlRequest::PairStart { start, attempt } => {
                self.start_inner(&start, attempt, now_ms)
            }
            ControlRequest::PairStatus { nonce } => (self.status(&nonce, now_ms), None),
            ControlRequest::PairAbandon { nonce, attempt } => {
                (self.abandon(&nonce, attempt, now_ms), None)
            }
            _ => (reject(PairError::Unavailable), None),
        };
        ControlResponse {
            ok: !matches!(reply, PairReply::Error { .. }),
            message: String::new(),
            host: None,
            allow_remote_monitoring: None,
            show_menu_bar_icon: None,
            launch_at_login: None,
            updates: None,
            pairing: Some(reply),
            pairing_expires_ms,
        }
    }

    /// The pairing client's view: `Waiting` until a final reply.
    pub fn status(&self, nonce: &str, now_ms: i64) -> PairReply {
        self.view(nonce, now_ms, false).0
    }

    /// Withdraws the relay's start. A committed host decision remains available.
    pub fn abandon(&self, nonce: &str, attempt: [u8; 16], now_ms: i64) -> PairReply {
        let mut state = self.state.lock_ok();
        let Some(offer) = state.offers.get_mut(nonce) else {
            return reject(PairError::Unknown);
        };
        if matches!(offer.phase, Phase::Offered { .. }) {
            // A timed-out start can still be queued on the control server. Reserve
            // the attempt so a delayed start cannot reopen the abandoned offer.
            offer.attempt = Some(attempt);
        }
        if offer.attempt.is_some_and(|accepted| accepted != attempt) {
            return reject(PairError::Used);
        }
        if matches!(offer.phase, Phase::Offered { .. } | Phase::Pending { .. }) {
            offer.phase = Phase::RemovingPairingLine((PairReply::Expired, None));
        }
        offer.refresh(self.keys.as_ref(), nonce, now_ms);
        offer.outcome(false).0
    }

    /// The approver's view: `Pending` with the device and code until a final reply.
    pub fn pending(&self, nonce: &str, now_ms: i64) -> PairReply {
        self.pending_with_summary(nonce, now_ms).0
    }

    /// The approver's reply and retained summary.
    pub fn pending_with_summary(&self, nonce: &str, now_ms: i64) -> PairOutcome {
        self.view(nonce, now_ms, true)
    }

    fn view(&self, nonce: &str, now_ms: i64, approver: bool) -> PairOutcome {
        let mut state = self.state.lock_ok();
        let Some(offer) = state.offers.get_mut(nonce) else {
            return (reject(PairError::Unknown), None);
        };
        offer.refresh(self.keys.as_ref(), nonce, now_ms);
        offer.outcome(approver)
    }

    /// Writes the device line, then removes the pairing line.
    pub fn approve(&self, nonce: &str, now_ms: i64) -> Result<PairReply, PairingError> {
        self.approve_with_summary(nonce, now_ms)
            .map(|(reply, _)| reply)
    }

    /// Approves the pairing and returns the reply and retained summary.
    pub fn approve_with_summary(
        &self,
        nonce: &str,
        now_ms: i64,
    ) -> Result<PairOutcome, PairingError> {
        let source = self.handover.lock_ok().clone();
        let mut state = self.state.lock_ok();
        let offer = state.offers.get_mut(nonce).ok_or(PairError::Unknown)?;
        offer.mark_expired(now_ms);
        let Phase::Pending {
            device_name, key, ..
        } = &offer.phase
        else {
            return self.finish_approval(offer, nonce);
        };
        let command = self.commands.restricted_for(DeviceTag::from_key(key));
        let device = self.keys.add_device(key, device_name, &command)?;
        let mut reply = PairReply::Approved {
            device: device.to_string(),
            hosts: vec![offer.host.clone()],
            unavailable: Vec::new(),
        };
        let summary = if let Some(source) = source {
            let (key, name) = (key.clone(), device_name.clone());
            offer.phase = Phase::HandingOver;
            drop(state);
            let handover = source.handover(device, &key, &name);
            let dropped = add_handover(&mut reply, &handover);
            state = self.state.lock_ok();
            Some(Arc::new(HandoverSummary { handover, dropped }))
        } else {
            None
        };
        let offer = state.offers.get_mut(nonce).ok_or(PairError::Unknown)?;
        offer.phase = Phase::RemovingPairingLine((reply, summary));
        self.finish_approval(offer, nonce)
    }

    fn finish_approval(&self, offer: &mut Offer, nonce: &str) -> Result<PairOutcome, PairingError> {
        offer.finish(self.keys.as_ref(), nonce)?;
        match &offer.phase {
            Phase::Finished(outcome) => Ok(outcome.clone()),
            Phase::HandingOver => Ok((PairReply::Waiting, None)),
            _ => Err(PairError::Invalid.into()),
        }
    }

    /// Refuses the pairing, removes its line and returns the resulting reply.
    pub fn deny(&self, nonce: &str) -> Result<PairReply, PairingError> {
        self.deny_with_summary(nonce).map(|(reply, _)| reply)
    }

    /// Denies an open offer or returns the completed outcome, including any summary.
    pub fn deny_with_summary(&self, nonce: &str) -> Result<PairOutcome, PairingError> {
        let mut state = self.state.lock_ok();
        let offer = state.offers.get_mut(nonce).ok_or(PairError::Unknown)?;
        offer.deny_if_open();
        offer.finish(self.keys.as_ref(), nonce)?;
        Ok(offer.outcome(true))
    }

    /// Withdraws the offer and removes its line.
    pub fn cancel(&self, nonce: &str) -> Result<(), PairingError> {
        self.deny(nonce).map(|_| ())
    }

    /// Withdraws a still-open offer and returns its deadline for the caller's status note.
    /// An already decided or unknown offer returns its current outcome and no deadline.
    pub fn withdraw_if_open(&self, nonce: &str, now_ms: i64) -> (PairOutcome, Option<i64>) {
        let mut state = self.state.lock_ok();
        let Some(offer) = state.offers.get_mut(nonce) else {
            return ((reject(PairError::Unknown), None), None);
        };
        offer.mark_expired(now_ms);
        let deadline = offer.deny_if_open().then_some(offer.expires_ms);
        offer.refresh(self.keys.as_ref(), nonce, now_ms);
        (offer.outcome(true), deadline)
    }

    /// Withdraws unfinished offers and stops accepting new offers on this host.
    pub fn cancel_open(&self, now_ms: i64) {
        let mut state = self.state.lock_ok();
        state.closing = true;
        for (nonce, offer) in &mut state.offers {
            offer.mark_expired(now_ms);
            offer.deny_if_open();
            offer.refresh(self.keys.as_ref(), nonce, now_ms);
        }
    }

    /// Expires every offer past its TTL at `now_ms`.
    pub fn expire(&self, now_ms: i64) {
        self.state.lock_ok().offers.retain(|nonce, offer| {
            offer.refresh(self.keys.as_ref(), nonce, now_ms);
            // Keep terminal replies available to the final poll and to late retries.
            !matches!(offer.phase, Phase::Finished(_))
                || now_ms < offer.expires_ms.saturating_add(RECEIPT_MS)
        });
    }
}

fn add_handover(reply: &mut PairReply, handover: &Handover) -> bool {
    if let PairReply::Approved {
        hosts, unavailable, ..
    } = reply
    {
        hosts.extend(handover.hosts.iter().cloned());
        unavailable.clone_from(&handover.unavailable);
    }
    if let Err(error) = encode_pair_frame(reply)
        && let PairReply::Approved {
            hosts, unavailable, ..
        } = reply
    {
        tracing::warn!(%error, "sending local-only pairing approval because the handover does not fit");
        hosts.truncate(1);
        unavailable.clear();
        return true;
    }
    false
}

impl Offer {
    fn start(&mut self, req: &PairStart, attempt: [u8; 16]) -> PairReply {
        if let Some(accepted) = self.attempt {
            return if attempt == accepted {
                self.outcome(false).0
            } else if matches!(self.phase, Phase::Pending { .. }) {
                reject(PairError::Busy)
            } else {
                reject(PairError::Used)
            };
        }
        let Phase::Offered { pairing_key } = &self.phase else {
            return self.outcome(false).0;
        };
        let Ok(key) = validate_start(req) else {
            return reject(PairError::Invalid);
        };
        if key == *pairing_key {
            return reject(PairError::Invalid);
        }
        self.attempt = Some(attempt);
        self.phase = Phase::Pending {
            device_name: req.device_name.clone(),
            model: req.model.clone(),
            key,
        };
        PairReply::Waiting
    }

    fn deny_if_open(&mut self) -> bool {
        if matches!(self.phase, Phase::Offered { .. } | Phase::Pending { .. }) {
            self.phase = Phase::RemovingPairingLine((PairReply::Denied, None));
            true
        } else {
            false
        }
    }

    fn mark_expired(&mut self, now_ms: i64) {
        if now_ms >= self.expires_ms
            && matches!(self.phase, Phase::Offered { .. } | Phase::Pending { .. })
        {
            self.phase = Phase::RemovingPairingLine((PairReply::Expired, None));
        }
    }

    fn finish(&mut self, keys: &dyn DeviceKeys, nonce: &str) -> Result<(), DeviceKeysError> {
        if let Phase::RemovingPairingLine(outcome) = &self.phase {
            keys.remove_pairing(nonce)?;
            self.phase = Phase::Finished(outcome.clone());
        }
        Ok(())
    }

    fn refresh(&mut self, keys: &dyn DeviceKeys, nonce: &str, now_ms: i64) {
        self.mark_expired(now_ms);
        if let Err(error) = self.finish(keys, nonce) {
            tracing::warn!(
                error = &error as &dyn std::error::Error,
                "removing the pairing line will be retried"
            );
        }
    }

    fn outcome(&self, approver: bool) -> PairOutcome {
        match &self.phase {
            Phase::Pending {
                device_name, model, ..
            } if approver => (
                PairReply::Pending {
                    device_name: device_name.clone(),
                    model: model.clone(),
                    code: self.code.clone(),
                },
                None,
            ),
            Phase::Finished(outcome) => outcome.clone(),
            Phase::RemovingPairingLine((reply @ (PairReply::Denied | PairReply::Expired), _)) => {
                (reply.clone(), None)
            }
            _ => (PairReply::Waiting, None),
        }
    }
}

fn entropy_error(error: p256::elliptic_curve::common::getrandom::Error) -> PairError {
    tracing::error!(%error, "generating pairing credentials");
    PairError::Unavailable
}

fn make_code() -> Result<String, PairError> {
    let alphabet = CODE_ALPHABET.as_bytes();
    let bound = 256 / alphabet.len() * alphabet.len();
    let mut code = String::new();
    while code.len() < 6 {
        for byte in <[u8; 6]>::try_generate().map_err(entropy_error)? {
            let n = usize::from(byte);
            if n < bound {
                code.push(char::from(alphabet[n % alphabet.len()]));
                if code.len() == 6 {
                    break;
                }
            }
        }
    }
    Ok(code)
}

fn validate_start(start: &PairStart) -> Result<EcdsaP256Public, PairError> {
    for label in [&start.device_name, &start.model] {
        if label.is_empty() || label.len() > 256 || label.chars().any(char::is_control) {
            return Err(PairError::Invalid);
        }
    }
    let bytes: [u8; 65] = start
        .device_key
        .as_slice()
        .try_into()
        .map_err(|_| PairError::Invalid)?;
    p256::PublicKey::from_sec1_bytes(&bytes).map_err(|_| PairError::Invalid)?;
    Ok(EcdsaP256Public(bytes))
}

fn reject(error: PairError) -> PairReply {
    PairReply::Error { error }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AuthorizedKeys;
    use statglass_proto::handover::HandoverReason;
    use statglass_schema::HostId;
    use std::{
        fs,
        path::PathBuf,
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        thread,
    };
    use uuid::Uuid;

    struct Source {
        keys: Arc<AuthorizedKeys>,
        calls: AtomicUsize,
        offered: BundleHost,
        unavailable: UnavailableHost,
        suspend_removal: PathBuf,
    }

    impl HandoverSource for Source {
        fn handover(&self, device: DeviceTag, key: &EcdsaP256Public, name: &str) -> Handover {
            let devices = self.keys.list_devices().unwrap();
            assert_eq!(devices.len(), 1);
            assert_eq!(devices[0].tag, device);
            assert_eq!(device, DeviceTag::from_key(key));
            assert_eq!(devices[0].name, name);
            self.calls.fetch_add(1, Ordering::Relaxed);
            // Simulate a filesystem failure between installing the device and
            // removing the one-time line.
            fs::rename(
                &self.suspend_removal,
                self.suspend_removal.with_extension("saved"),
            )
            .unwrap();
            fs::create_dir(&self.suspend_removal).unwrap();
            Handover {
                hosts: vec![self.offered.clone()],
                unavailable: vec![self.unavailable.clone()],
            }
        }
    }

    impl<F> HandoverSource for F
    where
        F: Fn(DeviceTag, &EcdsaP256Public, &str) -> Handover + Send + Sync,
    {
        fn handover(&self, tag: DeviceTag, key: &EcdsaP256Public, name: &str) -> Handover {
            self(tag, key, name)
        }
    }

    const NOW: i64 = 1_800_000_000_000;

    fn device_key() -> EcdsaP256Public {
        EcdsaP256Public::from_base64("BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=").unwrap()
    }

    fn request(pairing: &PairingHost, nonce: &str) {
        let start = PairStart {
            nonce: nonce.into(),
            device_key: device_key().0.into(),
            device_name: "Phone".into(),
            model: "iPhone".into(),
        };
        let reply = pairing.control_reply(
            ControlRequest::PairStart {
                start,
                attempt: [1; 16],
            },
            NOW,
        );
        assert_eq!(reply.pairing, Some(PairReply::Waiting));
    }

    fn host(keys: Arc<AuthorizedKeys>) -> PairingHost {
        PairingHost::new(
            keys,
            PairCommands {
                pair: "/helper pair".into(),
                restricted: "/helper restricted".into(),
            },
        )
    }

    fn bundle(id: u128, name: &str) -> BundleHost {
        BundleHost {
            host_id: HostId(Uuid::from_u128(id)),
            name: name.into(),
            os: "macos".into(),
            user: "tester".into(),
            port: None,
            targets: vec![],
            host_keys: vec![],
        }
    }

    #[test]
    fn approval_hands_over_other_hosts_once_and_after_installing_the_local_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("authorized_keys");
        let keys = Arc::new(AuthorizedKeys::at(path.clone()));
        let pairing = host(keys.clone());
        let mac = bundle(1, "Mac");
        let source = Arc::new(Source {
            keys,
            calls: AtomicUsize::new(0),
            offered: bundle(2, "Workshop"),
            unavailable: UnavailableHost {
                host_id: HostId(Uuid::from_u128(3)),
                name: "Office".into(),
                reason: HandoverReason::ProxyJump,
            },
            suspend_removal: path.clone(),
        });
        let standalone = pairing.offer(mac.clone(), Duration::ZERO, NOW).unwrap();
        assert!(!standalone.can_hand_over);
        pairing.cancel(&standalone.nonce).unwrap();
        pairing.set_handover(source.clone());
        let payload = pairing.offer(mac.clone(), Duration::ZERO, NOW).unwrap();
        assert!(payload.can_hand_over);
        let nonce = payload.nonce;
        request(&pairing, &nonce);
        assert_eq!(source.calls.load(Ordering::Relaxed), 0);
        let expected = PairReply::Approved {
            device: DeviceTag::from_key(&device_key()).to_string(),
            hosts: vec![mac, source.offered.clone()],
            unavailable: vec![source.unavailable.clone()],
        };
        assert!(pairing.approve(&nonce, NOW).is_err());
        let (reply, summary) = pairing.pending_with_summary(&nonce, NOW);
        assert_eq!(reply, PairReply::Waiting);
        assert!(summary.is_none());
        fs::remove_dir(&path).unwrap();
        fs::rename(path.with_extension("saved"), &path).unwrap();
        let assert_outcome = |(reply, summary): PairOutcome| {
            assert_eq!(reply, expected);
            let summary = summary.expect("an approved reply retains its summary");
            assert_eq!(
                summary.handover.hosts,
                std::slice::from_ref(&source.offered)
            );
            assert_eq!(
                summary.handover.unavailable,
                std::slice::from_ref(&source.unavailable)
            );
            assert!(!summary.dropped);
        };
        assert_outcome(pairing.approve_with_summary(&nonce, NOW).unwrap());
        let later = payload.expires_ms + 1;
        pairing.expire(later);
        assert_eq!(pairing.status(&nonce, later), expected);
        assert_outcome(pairing.approve_with_summary(&nonce, later).unwrap());
        let retained = pairing.pending_with_summary(&nonce, later);
        assert_eq!(source.calls.load(Ordering::Relaxed), 1);

        let receipt_end = payload.expires_ms + RECEIPT_MS;
        pairing.expire(receipt_end);
        assert_outcome(retained);
        assert!(matches!(
            pairing.pending_with_summary(&nonce, receipt_end),
            (
                PairReply::Error {
                    error: PairError::Unknown
                },
                None
            )
        ));
    }

    #[test]
    fn approval_without_a_handover_source_has_no_summary() {
        let dir = tempfile::tempdir().unwrap();
        let pairing = host(Arc::new(AuthorizedKeys::at(
            dir.path().join("authorized_keys"),
        )));
        let mac = bundle(1, "Mac");
        let nonce = pairing
            .offer(mac.clone(), Duration::ZERO, NOW)
            .unwrap()
            .nonce;
        request(&pairing, &nonce);
        let (reply, summary) = pairing.approve_with_summary(&nonce, NOW).unwrap();
        assert_eq!(
            reply,
            PairReply::Approved {
                device: DeviceTag::from_key(&device_key()).to_string(),
                hosts: vec![mac],
                unavailable: Vec::new(),
            },
        );
        assert!(summary.is_none());
    }

    #[test]
    fn status_and_other_offers_can_progress_while_handover_resolves() {
        let dir = tempfile::tempdir().unwrap();
        let pairing = host(Arc::new(AuthorizedKeys::at(
            dir.path().join("authorized_keys"),
        )));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let resume_rx = Mutex::new(resume_rx);
        pairing.set_handover(Arc::new(
            move |_: DeviceTag, _: &EcdsaP256Public, _: &str| {
                entered_tx.send(()).unwrap();
                resume_rx
                    .lock_ok()
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap();
                Handover {
                    hosts: Vec::new(),
                    unavailable: Vec::new(),
                }
            },
        ));
        let nonce = pairing
            .offer(bundle(1, "Mac"), Duration::ZERO, NOW)
            .unwrap()
            .nonce;
        request(&pairing, &nonce);
        thread::scope(|scope| {
            let approve = scope.spawn(|| pairing.approve(&nonce, NOW));
            entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            let (poll_tx, poll_rx) = mpsc::channel();
            let (p, n) = (&pairing, &nonce);
            scope.spawn(move || {
                let status = p.status(n, NOW);
                let next = p.offer(bundle(2, "Mac"), Duration::ZERO, NOW);
                poll_tx.send((status, next)).unwrap();
            });
            let result = poll_rx.recv_timeout(Duration::from_secs(2));
            resume_tx.send(()).unwrap();
            let (status, next) = result.expect("pairing operations can run during handover");
            assert_eq!(status, PairReply::Waiting);
            assert!(next.is_ok());
            assert!(matches!(
                approve.join().unwrap().unwrap(),
                PairReply::Approved { .. }
            ));
        });
    }

    #[test]
    fn oversized_handover_still_delivers_an_encodable_local_approval() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Arc::new(AuthorizedKeys::at(dir.path().join("authorized_keys")));
        let pairing = host(keys.clone());
        let oversized = bundle(
            2,
            &"x".repeat(statglass_proto::pairing::MAX_PAIR_FRAME_BYTES),
        );
        let source_host = oversized.clone();
        pairing.set_handover(Arc::new(
            move |_: DeviceTag, _: &EcdsaP256Public, _: &str| Handover {
                hosts: vec![source_host.clone()],
                unavailable: Vec::new(),
            },
        ));
        let mac = bundle(1, "Mac");
        let nonce = pairing
            .offer(mac.clone(), Duration::ZERO, NOW)
            .unwrap()
            .nonce;
        request(&pairing, &nonce);
        let (reply, summary) = pairing.approve_with_summary(&nonce, NOW).unwrap();
        assert!(encode_pair_frame(&reply).is_ok());
        assert!(matches!(reply, PairReply::Approved { hosts, .. } if hosts == [mac]));
        let summary = summary.unwrap();
        assert!(summary.dropped);
        assert_eq!(summary.handover.hosts, [oversized]);
        assert!(summary.handover.unavailable.is_empty());
        assert_eq!(keys.list_devices().unwrap().len(), 1);
    }
}
