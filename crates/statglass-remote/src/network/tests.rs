use super::*;
use crate::ConnectionFailureKind as K;

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

#[test]
fn tailscale_ranges_are_classified_at_their_edges() {
    for addr in [
        "100.64.0.1",
        "100.100.100.100",
        "100.127.255.254",
        "fd7a:115c:a1e0::1",
    ] {
        assert_eq!(
            classify_address(ip(addr)),
            AddressClass::Tailscale,
            "{addr}"
        );
    }
    for addr in [
        "100.63.255.255",
        "100.128.0.0",
        "192.168.1.20",
        "10.0.0.5",
        "2600:1700::5",
    ] {
        assert_eq!(classify_address(ip(addr)), AddressClass::Routable, "{addr}");
    }
}

#[test]
fn loopback_link_local_and_unspecified_do_not_count() {
    for addr in [
        "127.0.0.1",
        "::1",
        "169.254.10.2",
        "fe80::1",
        "0.0.0.0",
        "::",
    ] {
        assert_eq!(classify_address(ip(addr)), AddressClass::Ignored, "{addr}");
    }
}

const ONLINE: LocalNetwork = LocalNetwork {
    online: true,
    tailscale_up: true,
};
const OFFLINE: LocalNetwork = LocalNetwork {
    online: false,
    tailscale_up: false,
};
const NO_TAILSCALE: LocalNetwork = LocalNetwork {
    online: true,
    tailscale_up: false,
};

#[test]
fn offline_turns_network_failures_into_local_offline() {
    for kind in [K::NameNotResolved, K::NoRoute, K::Timeout, K::Unreachable] {
        for route in [Route::Lan, Route::Tailscale] {
            assert_eq!(
                refine(kind, route, OFFLINE),
                K::LocalOffline,
                "{kind:?} {route:?}"
            );
        }
    }
}

#[test]
fn a_refusal_proves_a_host_answered_even_when_offline() {
    assert_eq!(refine(K::Refused, Route::Lan, OFFLINE), K::Refused);
}

#[test]
fn tailscale_route_with_tailscale_down_reads_tailscale_down() {
    for kind in [K::NameNotResolved, K::NoRoute, K::Timeout, K::Unreachable] {
        assert_eq!(
            refine(kind, Route::Tailscale, NO_TAILSCALE),
            K::TailscaleDown,
            "{kind:?}"
        );
        assert_eq!(
            refine(kind, Route::Lan, NO_TAILSCALE),
            kind,
            "LAN ignores Tailscale: {kind:?}"
        );
    }
}

#[test]
fn healthy_network_leaves_the_cause_alone() {
    for kind in [
        K::NameNotResolved,
        K::NoRoute,
        K::Timeout,
        K::Unreachable,
        K::Refused,
    ] {
        assert_eq!(refine(kind, Route::Tailscale, ONLINE), kind);
    }
}

#[test]
fn non_network_kinds_are_never_refined() {
    for kind in [
        K::Authentication,
        K::HostKey,
        K::AgentNotRunning,
        K::Incompatible,
        K::IdentityChanged,
        K::Protocol,
    ] {
        for net in [OFFLINE, NO_TAILSCALE] {
            assert_eq!(refine(kind, Route::Tailscale, net), kind, "{kind:?}");
        }
    }
}

#[test]
fn probe_reads_this_machine_without_failing() {
    // The test machine has loopback at least; the probe must return rather than panic.
    let _ = probe();
}
