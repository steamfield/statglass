use std::collections::{BTreeMap, HashSet};

use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
use statglass_ipc::{
    error::{CommandError, PairingFailure},
    mobile::{
        BundleReconcile, HandoverReasonInfo, MobileCommand, MobileHost, MobileHostKey,
        MobileTarget, OfferedHost, UnavailableHostInfo,
    },
    status::RemoteRoute,
};
use statglass_proto::{
    handover::{self as proto, HandoverReason, HostBundle, UnavailableHost},
    pairing::{BundleHost, BundleHostKey, BundleRoute, BundleTarget},
};
use statglass_schema::HostId;
use statglass_session::{
    ForcedToken, RemoteCommand,
    handover::{CurrentHost, Reconcile, reconcile},
    pairing::endpoint_from_host,
};

use crate::{host_store::HostStore, sessions::Sessions};

#[derive(Clone)]
pub(crate) enum PendingHandover {
    Pairing {
        from: HostId,
        offered: Vec<OfferedHost>,
    },
    Bundle {
        id: u32,
        bundle: HostBundle,
    },
}

pub(crate) fn decode_bundle(
    sessions: &Sessions,
    text: &str,
) -> Result<BundleReconcile, CommandError> {
    let bundle = proto::decode_bundle(text.trim()).map_err(|_| invalid_bundle())?;
    sessions.stage_bundle(bundle)
}

pub(crate) fn add_handover_hosts(
    sessions: &Sessions,
    hosts: Vec<OfferedHost>,
    preview_id: Option<u32>,
) -> Result<(), CommandError> {
    sessions.add_handover_hosts(hosts, preview_id)
}

pub(crate) fn validate_bundle(
    phone: HostId,
    store: &HostStore,
    bundle: &HostBundle,
) -> Result<(), CommandError> {
    if store
        .applied_bundles
        .get(&bundle.from)
        .is_some_and(|issued_ms| bundle.issued_ms < *issued_ms)
    {
        return Err(invalid(
            "This update is older than the last one from this Mac. Get a new code on your Mac.",
        ));
    }
    let mut ids = HashSet::from([phone, bundle.from]);
    if phone == bundle.from
        || bundle
            .hosts
            .iter()
            .any(|host| !ids.insert(host.host_id) || !valid_endpoint(host))
        || bundle
            .unavailable
            .iter()
            .any(|host| !ids.insert(host.host_id))
    {
        return Err(invalid_bundle());
    }
    Ok(())
}

fn invalid_bundle() -> CommandError {
    invalid("Scan or paste an Update iPhone code from StatGlass on your Mac.")
}

fn invalid(message: &str) -> CommandError {
    CommandError::Pairing {
        reason: PairingFailure::Invalid,
        message: message.into(),
    }
}

fn valid_endpoint(host: &BundleHost) -> bool {
    endpoint_from_host(
        host,
        RemoteCommand::Restricted {
            forced: ForcedToken::Serve,
        },
    )
    .is_ok()
        && host.host_keys.iter().all(|key| {
            !key.algorithm.is_empty()
                && !key.algorithm.chars().any(char::is_whitespace)
                && key
                    .sha256
                    .strip_prefix("SHA256:")
                    .is_some_and(|hash| hash.len() == 43 && STANDARD_NO_PAD.decode(hash).is_ok())
        })
}

pub(crate) fn preview(
    preview_id: u32,
    hosts: &[MobileHost],
    controllers: &BTreeMap<HostId, HostId>,
    bundle: &HostBundle,
) -> BundleReconcile {
    let result = reconcile_hosts(hosts, controllers, bundle);
    BundleReconcile {
        from: bundle.from,
        preview_id,
        new: result.new.into_iter().map(offered_host).collect(),
        changed: result
            .changed
            .into_iter()
            .map(|host| host.host_id)
            .collect(),
        removed: result.removed,
        unavailable: result
            .unavailable
            .into_iter()
            .map(unavailable_host)
            .collect(),
    }
}

fn reconcile_hosts(
    hosts: &[MobileHost],
    controllers: &BTreeMap<HostId, HostId>,
    bundle: &HostBundle,
) -> Reconcile {
    let current: Vec<_> = hosts
        .iter()
        .filter(|host| controllers.get(&host.id) == Some(&bundle.from))
        .map(|host| CurrentHost {
            endpoint: bundle_host(host),
            removed_by_controller: host.removed_by_controller,
        })
        .collect();
    let mut result = reconcile(&current, bundle);
    result
        .new
        .retain(|candidate| hosts.iter().all(|host| host.id != candidate.host_id));
    result
}

pub(crate) fn apply(
    phone: HostId,
    hosts: &mut Vec<MobileHost>,
    store: &mut HostStore,
    pending: Option<PendingHandover>,
    selected: Vec<OfferedHost>,
    preview_id: Option<u32>,
) -> Result<(), CommandError> {
    let stale = || invalid("Open the host offer again before applying these changes.");
    let (from, offered, changed, removed) = match (pending, preview_id) {
        (Some(PendingHandover::Pairing { from, offered }), None) if !selected.is_empty() => {
            (from, offered, Vec::new(), Vec::new())
        }
        (Some(PendingHandover::Bundle { id, bundle }), Some(preview_id)) if id == preview_id => {
            let result = reconcile_hosts(hosts, &store.controllers, &bundle);
            store.applied_bundles.insert(bundle.from, bundle.issued_ms);
            (
                bundle.from,
                bundle.hosts.into_iter().map(offered_host).collect(),
                result.changed,
                result.removed,
            )
        }
        _ => return Err(stale()),
    };
    let mut ids = HashSet::from([phone, from]);
    for host in &selected {
        if !ids.insert(host.id) || !offered.contains(host) {
            return Err(stale());
        }
    }
    for endpoint in changed {
        if let Some(current) = hosts.iter_mut().find(|host| host.id == endpoint.host_id) {
            let mut updated = restricted(offered_host(endpoint));
            updated.name.clone_from(&current.name);
            *current = updated;
        }
    }
    for host in hosts.iter_mut().filter(|host| removed.contains(&host.id)) {
        host.removed_by_controller = true;
    }
    for offer in selected {
        if hosts.iter().any(|host| host.id == offer.id) {
            continue;
        }
        let host = restricted(offer);
        if !valid_endpoint(&bundle_host(&host)) {
            return Err(invalid(
                "This offer has invalid SSH details. Ask for a new offer on your Mac.",
            ));
        }
        store.controllers.insert(host.id, from);
        hosts.push(host);
    }
    Ok(())
}

pub(crate) fn offered_host(host: BundleHost) -> OfferedHost {
    OfferedHost {
        id: host.host_id,
        name: host.name,
        os: host.os,
        user: host.user,
        port: host.port,
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
        host_keys: host
            .host_keys
            .into_iter()
            .map(|key| MobileHostKey {
                algorithm: key.algorithm,
                sha256: key.sha256,
            })
            .collect(),
    }
}

pub(crate) fn unavailable_host(host: UnavailableHost) -> UnavailableHostInfo {
    UnavailableHostInfo {
        id: host.host_id,
        name: host.name,
        reason: match host.reason {
            HandoverReason::ProxyJump => HandoverReasonInfo::ProxyJump,
            HandoverReason::ProxyCommand => HandoverReasonInfo::ProxyCommand,
            HandoverReason::LanLiteral => HandoverReasonInfo::LanLiteral,
            HandoverReason::NoHostKey => HandoverReasonInfo::NoHostKey,
            HandoverReason::Unresolvable => HandoverReasonInfo::Unresolvable,
        },
    }
}

fn restricted(offer: OfferedHost) -> MobileHost {
    MobileHost {
        id: offer.id,
        name: offer.name,
        user: offer.user,
        port: offer.port,
        targets: offer.targets,
        host_keys: offer.host_keys,
        command: MobileCommand::Restricted,
        removed_by_controller: false,
    }
}

fn bundle_host(host: &MobileHost) -> BundleHost {
    BundleHost {
        host_id: host.id,
        name: host.name.clone(),
        os: String::new(),
        user: host.user.clone(),
        port: host.port,
        targets: host
            .targets
            .iter()
            .map(|target| BundleTarget {
                route: match target.route {
                    RemoteRoute::Lan => BundleRoute::Lan,
                    RemoteRoute::Tailscale => BundleRoute::Tailscale,
                },
                host: target.host.clone(),
            })
            .collect(),
        host_keys: host
            .host_keys
            .iter()
            .map(|key| BundleHostKey {
                algorithm: key.algorithm.clone(),
                sha256: key.sha256.clone(),
            })
            .collect(),
    }
}
