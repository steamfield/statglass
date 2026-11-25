//! The host side of pairing (RFC `plan/rfc-ios-app.md` 2.4): offer a one-time pairing
//! key, bind it to the first `PairStart`, and complete only when the host's approver
//! says so. Also the forced `pair` command every host runs for the phone.
use crate::device_keys::{DeviceKeys, DeviceKeysError, DeviceTag, EcdsaP256Public};
use crate::{ControlRequest, ControlResponse};
use p256::elliptic_curve::{Generate, sec1::ToSec1Point};
use statglass_proto::pairing::{
    BundleHost, CODE_ALPHABET, PAYLOAD_VERSION, PairError, PairReply, PairStart, PairingPayload,
};
use statglass_schema::lock::LockExt;
pub use statglass_session::{
    MAX_TARGETS, command::shell_quote, network::usable_interface_addresses,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod relay;
pub use relay::{run_forced, run_forced_for_nonce};

/// The `command=` prefixes for the lines pairing installs; the nonce or device tag is
/// appended.
pub struct PairCommands {
    /// The forced `pair` command, before `--nonce <n>`.
    pub pair: String,
    /// The forced restricted command, before `--device <tag>`.
    pub restricted: String,
}

/// Why the host could not offer or decide a pairing.
#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error(transparent)]
    Keys(#[from] DeviceKeysError),
    #[error("{0}")]
    Pair(#[from] PairError),
}

/// Every open pairing offer on this host and the keys it edits.
pub struct PairingHost {
    keys: Arc<dyn DeviceKeys>,
    commands: PairCommands,
    offers: Mutex<HashMap<String, Offer>>,
}

struct Offer {
    host: BundleHost,
    code: String,
    expires_ms: i64,
    used: bool,
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
    RemovingPairingLine(PairReply),
    Finished(PairReply),
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
            offers: Mutex::default(),
        }
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
        let mut offers = self.offers.lock_ok();
        if offers.contains_key(&nonce) {
            return Err(PairError::Unavailable.into());
        }
        self.keys
            .add_pairing(&public, &nonce, expires_ms, &command)?;
        offers.insert(
            nonce.clone(),
            Offer {
                host: host.clone(),
                code: code.clone(),
                expires_ms,
                used: false,
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
        })
    }

    /// Binds the offer to the phone's first valid `PairStart`.
    pub fn start(&self, req: &PairStart, now_ms: i64) -> PairReply {
        self.start_inner(req, None, now_ms).0
    }

    /// Starts an exchange for the relay on the owner-only control socket. Retries
    /// of that local request can recover a lost reply without accepting new starts.
    pub fn start_attempt(&self, req: &PairStart, attempt: [u8; 16], now_ms: i64) -> PairReply {
        self.start_inner(req, Some(attempt), now_ms).0
    }

    fn start_inner(
        &self,
        req: &PairStart,
        attempt: Option<[u8; 16]>,
        now_ms: i64,
    ) -> (PairReply, Option<i64>) {
        let mut offers = self.offers.lock_ok();
        let Some(offer) = offers.get_mut(&req.nonce) else {
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
                self.start_inner(&start, Some(attempt), now_ms)
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
        self.view(nonce, now_ms, false)
    }

    /// Withdraws the relay's start. A committed host decision remains available.
    pub fn abandon(&self, nonce: &str, attempt: [u8; 16], now_ms: i64) -> PairReply {
        let mut offers = self.offers.lock_ok();
        let Some(offer) = offers.get_mut(nonce) else {
            return reject(PairError::Unknown);
        };
        if matches!(offer.phase, Phase::Offered { .. }) {
            // A timed-out start can still be queued on the control server. Reserve
            // the attempt so a delayed start cannot reopen the abandoned offer.
            offer.used = true;
            offer.attempt = Some(attempt);
        }
        if offer.used && offer.attempt != Some(attempt) {
            return reject(PairError::Used);
        }
        if matches!(offer.phase, Phase::Offered { .. } | Phase::Pending { .. }) {
            offer.phase = Phase::RemovingPairingLine(PairReply::Expired);
        }
        offer.refresh(self.keys.as_ref(), nonce, now_ms);
        offer.reply(false)
    }

    /// The approver's view: `Pending` with the device and code until a final reply.
    pub fn pending(&self, nonce: &str, now_ms: i64) -> PairReply {
        self.view(nonce, now_ms, true)
    }

    fn view(&self, nonce: &str, now_ms: i64, approver: bool) -> PairReply {
        let mut offers = self.offers.lock_ok();
        let Some(offer) = offers.get_mut(nonce) else {
            return reject(PairError::Unknown);
        };
        offer.refresh(self.keys.as_ref(), nonce, now_ms);
        offer.reply(approver)
    }

    /// Writes the device line, then removes the pairing line.
    pub fn approve(&self, nonce: &str, now_ms: i64) -> Result<PairReply, PairingError> {
        let mut offers = self.offers.lock_ok();
        let offer = offers.get_mut(nonce).ok_or(PairError::Unknown)?;
        offer.mark_expired(now_ms);
        if let Phase::Pending {
            device_name, key, ..
        } = &offer.phase
        {
            let tag = DeviceTag::from_key(key);
            let command = format!("{} --device {tag}", self.commands.restricted);
            let device = self
                .keys
                .add_device(key, device_name, &command)?
                .to_string();
            offer.phase = Phase::RemovingPairingLine(PairReply::Approved {
                device,
                hosts: vec![offer.host.clone()],
            });
        }
        offer.finish(self.keys.as_ref(), nonce)?;
        match &offer.phase {
            Phase::Finished(reply) => Ok(reply.clone()),
            _ => Err(PairError::Invalid.into()),
        }
    }

    /// Refuses the pairing and removes its line.
    pub fn deny(&self, nonce: &str) -> Result<(), PairingError> {
        let mut offers = self.offers.lock_ok();
        let offer = offers.get_mut(nonce).ok_or(PairError::Unknown)?;
        if matches!(offer.phase, Phase::Offered { .. } | Phase::Pending { .. }) {
            offer.phase = Phase::RemovingPairingLine(PairReply::Denied);
        }
        offer.finish(self.keys.as_ref(), nonce)?;
        Ok(())
    }

    /// Withdraws the offer and removes its line.
    pub fn cancel(&self, nonce: &str) -> Result<(), PairingError> {
        self.deny(nonce)
    }

    /// Expires every offer past its TTL at `now_ms`.
    pub fn expire(&self, now_ms: i64) {
        self.offers.lock_ok().retain(|nonce, offer| {
            offer.refresh(self.keys.as_ref(), nonce, now_ms);
            // Keep terminal replies available to the final poll and to late retries.
            !matches!(offer.phase, Phase::Finished(_))
                || now_ms < offer.expires_ms.saturating_add(RECEIPT_MS)
        });
    }
}

impl Offer {
    fn start(&mut self, req: &PairStart, attempt: Option<[u8; 16]>) -> PairReply {
        if self.used {
            return if attempt.is_some() && attempt == self.attempt {
                self.reply(false)
            } else {
                reject(PairError::Used)
            };
        }
        let Phase::Offered { pairing_key } = &self.phase else {
            return self.reply(false);
        };
        let Ok(key) = validate_start(req) else {
            return reject(PairError::Invalid);
        };
        if key == *pairing_key {
            return reject(PairError::Invalid);
        }
        self.used = true;
        self.attempt = attempt;
        self.phase = Phase::Pending {
            device_name: req.device_name.clone(),
            model: req.model.clone(),
            key,
        };
        PairReply::Waiting
    }

    fn mark_expired(&mut self, now_ms: i64) {
        if now_ms >= self.expires_ms
            && matches!(self.phase, Phase::Offered { .. } | Phase::Pending { .. })
        {
            self.phase = Phase::RemovingPairingLine(PairReply::Expired);
        }
    }

    fn finish(&mut self, keys: &dyn DeviceKeys, nonce: &str) -> Result<(), DeviceKeysError> {
        if let Phase::RemovingPairingLine(reply) = &self.phase {
            keys.remove_pairing(nonce)?;
            self.phase = Phase::Finished(reply.clone());
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

    fn reply(&self, approver: bool) -> PairReply {
        match &self.phase {
            Phase::Pending {
                device_name, model, ..
            } if approver => PairReply::Pending {
                device_name: device_name.clone(),
                model: model.clone(),
                code: self.code.clone(),
            },
            Phase::Finished(reply) => reply.clone(),
            Phase::RemovingPairingLine(PairReply::Denied) => PairReply::Denied,
            Phase::RemovingPairingLine(PairReply::Expired) => PairReply::Expired,
            _ => PairReply::Waiting,
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
