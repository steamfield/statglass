//! Compares a controller's bundle with the hosts already on the phone.

use std::collections::HashMap;

use statglass_proto::{
    handover::{HostBundle, UnavailableHost},
    pairing::BundleHost,
};
use statglass_schema::HostId;

pub struct CurrentHost {
    pub endpoint: BundleHost,
    pub removed_by_controller: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Reconcile {
    pub new: Vec<BundleHost>,
    pub removed: Vec<HostId>,
    pub changed: Vec<BundleHost>,
    pub unavailable: Vec<UnavailableHost>,
}

/// Compares the hosts tracked for this controller, in bundle order for additions
/// and changes and in phone order for removals.
pub fn reconcile(current: &[CurrentHost], bundle: &HostBundle) -> Reconcile {
    let mut known: HashMap<_, _> = current
        .iter()
        .map(|host| (host.endpoint.host_id, host))
        .collect();
    let mut result = Reconcile {
        unavailable: bundle.unavailable.clone(),
        ..Reconcile::default()
    };
    for host in &bundle.hosts {
        match known.remove(&host.host_id) {
            None => result.new.push(host.clone()),
            Some(current)
                if current.removed_by_controller || endpoint_changed(&current.endpoint, host) =>
            {
                result.changed.push(host.clone());
            }
            Some(_) => {}
        }
    }
    for host in &bundle.unavailable {
        if let Some(current) = known.remove(&host.host_id)
            && current.removed_by_controller
        {
            result.changed.push(current.endpoint.clone());
        }
    }
    result.removed = current
        .iter()
        .map(|host| host.endpoint.host_id)
        .filter(|id| known.contains_key(id))
        .collect();
    result
}

fn endpoint_changed(old: &BundleHost, new: &BundleHost) -> bool {
    old.user != new.user
        || old.port.unwrap_or(22) != new.port.unwrap_or(22)
        || old.targets != new.targets
        || old.host_keys.iter().any(|key| !new.host_keys.contains(key))
        || new.host_keys.iter().any(|key| !old.host_keys.contains(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use statglass_proto::handover::HandoverReason;
    use statglass_proto::pairing::{BundleHostKey, BundleRoute, BundleTarget};
    use uuid::Uuid;

    fn id(n: u8) -> HostId {
        HostId(Uuid::from_u128(n.into()))
    }

    fn host(n: u8) -> BundleHost {
        BundleHost {
            host_id: id(n),
            name: format!("Host {n}"),
            os: "linux".into(),
            user: "riley".into(),
            port: None,
            targets: vec![BundleTarget {
                route: BundleRoute::Lan,
                host: format!("host-{n}.local"),
            }],
            host_keys: vec![
                BundleHostKey {
                    algorithm: "ssh-ed25519".into(),
                    sha256: "SHA256:first".into(),
                },
                BundleHostKey {
                    algorithm: "ssh-rsa".into(),
                    sha256: "SHA256:second".into(),
                },
            ],
        }
    }

    #[test]
    fn handover_reconciles_additions_endpoint_changes_and_removals_by_id() {
        let current: Vec<_> = (1..=6)
            .map(|n| CurrentHost {
                endpoint: host(n),
                removed_by_controller: n >= 4,
            })
            .collect();
        let mut unchanged = host(1);
        unchanged.name = "New Mac-side name".into();
        unchanged.port = Some(22);
        unchanged.host_keys.reverse();
        let mut target_changed = host(2);
        target_changed.targets[0].host = "new-address.local".into();
        let mut key_changed = host(3);
        key_changed.host_keys[0].sha256 = "SHA256:new".into();
        let unavailable = UnavailableHost {
            host_id: id(5),
            name: "Host 5".into(),
            reason: HandoverReason::NoHostKey,
        };
        let bundle = HostBundle {
            version: 1,
            from: id(99),
            hosts: vec![
                unchanged,
                target_changed.clone(),
                key_changed.clone(),
                host(4),
                host(7),
            ],
            unavailable: vec![unavailable.clone()],
            issued_ms: 0,
        };
        assert_eq!(
            reconcile(&current, &bundle),
            Reconcile {
                new: vec![host(7)],
                changed: vec![target_changed, key_changed, host(4), host(5)],
                removed: vec![id(6)],
                unavailable: vec![unavailable],
            }
        );
    }
}
