use std::sync::Arc;

use statglass_engine::wall_ms;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{
    MobileCommand, MobileHost, MobileHostKey, MobileTarget, PairedHost, PairingPreview,
    PairingState,
};
use statglass_ipc::status::RemoteRoute;
use statglass_proto::pairing::{BundleRoute, PairError, PairingPayload, parse_payload};
use statglass_schema::HostId;
use statglass_session::pairing::{self as session_pairing, PairingRefusal};
use statglass_session::{Dialer, Endpoint, RemoteError, Route};
use statglass_ssh::{EphemeralSigner, RusshDialer, Signer};

use crate::sessions::Sessions;

#[cfg(test)]
mod tests;

pub(crate) fn preview(text: &str, now_ms: i64) -> Result<PairingPreview, CommandError> {
    let payload = decode(text, now_ms)?;
    let host = payload.host;
    Ok(PairingPreview {
        host_id: host.host_id,
        name: host.name,
        os: host.os,
        user: host.user,
        targets: host
            .targets
            .into_iter()
            .map(|target| MobileTarget {
                route: match target.route {
                    BundleRoute::Lan => RemoteRoute::Lan,
                    BundleRoute::Tailscale => RemoteRoute::Tailscale,
                },
                host: target.host,
            })
            .collect(),
        code: payload.code,
        expires_ms: payload.expires_ms,
        can_hand_over: payload.can_hand_over,
    })
}

pub(crate) async fn pair(
    sessions: &Sessions,
    device_key: Vec<u8>,
    text: String,
    device_name: String,
    model: String,
) -> Result<PairedHost, CommandError> {
    pair_with_dialer(
        sessions,
        device_key,
        &text,
        &device_name,
        &model,
        RusshDialer::new,
    )
    .await
}

async fn pair_with_dialer<D: Dialer>(
    sessions: &Sessions,
    device_key: Vec<u8>,
    text: &str,
    device_name: &str,
    model: &str,
    dialer: impl FnOnce(Arc<dyn Signer>) -> D,
) -> Result<PairedHost, CommandError> {
    let phone = sessions.phone_id()?;
    let host = {
        let payload = decode(text, wall_ms())?;
        if payload.host.host_id == phone {
            return Err(RemoteError::Identity("cannot pair this device to itself".into()).into());
        }
        let signer = EphemeralSigner::from_scalar(&payload.pairing_key)
            .map_err(|_| RemoteError::from(PairingRefusal::Rejected(PairError::Invalid)))?;
        let dialer = dialer(Arc::new(signer));
        let (endpoint, _) =
            session_pairing::pair(&dialer, &payload, &device_key, device_name, model, phone)
                .await?;
        restricted_host(payload.host.host_id, payload.host.name, endpoint)?
    };

    let sessions = sessions.clone();
    tokio::task::spawn_blocking(move || sessions.add_paired_host(host, &device_key))
        .await
        .map_err(|error| CommandError::Internal {
            message: format!("saving the approved pairing: {error}"),
        })?
}

pub(crate) fn state(sessions: &Sessions) -> PairingState {
    sessions.pairing_state()
}

fn decode(text: &str, now_ms: i64) -> Result<PairingPayload, RemoteError> {
    let payload = parse_payload(text.trim()).map_err(PairingRefusal::Rejected)?;
    if now_ms >= payload.expires_ms {
        return Err(PairingRefusal::Expired.into());
    }
    Ok(payload)
}

fn restricted_host(
    id: HostId,
    name: String,
    endpoint: Endpoint,
) -> Result<MobileHost, RemoteError> {
    let user = endpoint
        .user
        .ok_or_else(|| RemoteError::Protocol("pairing approval has no SSH user".into()))?;
    Ok(MobileHost {
        id,
        name,
        user,
        port: endpoint.port,
        targets: endpoint
            .targets
            .into_iter()
            .map(|target| MobileTarget {
                route: match target.route {
                    Route::Lan => RemoteRoute::Lan,
                    Route::Tailscale => RemoteRoute::Tailscale,
                },
                host: target.host,
            })
            .collect(),
        host_keys: endpoint
            .host_keys
            .into_iter()
            .map(|key| MobileHostKey {
                algorithm: key.algorithm,
                sha256: key.sha256,
            })
            .collect(),
        command: MobileCommand::Restricted,
    })
}
