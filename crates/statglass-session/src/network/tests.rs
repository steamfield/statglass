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
    lan_up: true,
};
const OFFLINE: LocalNetwork = LocalNetwork {
    online: false,
    tailscale_up: false,
    lan_up: false,
};
const NO_TAILSCALE: LocalNetwork = LocalNetwork {
    online: true,
    tailscale_up: false,
    lan_up: true,
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

fn entry(name: &str, addr: &str) -> interfaces::InterfaceAddress {
    interfaces::InterfaceAddress {
        name: name.into(),
        addr: ip(addr),
    }
}

#[test]
fn virtual_bridges_and_vpn_tunnels_do_not_count_toward_online() {
    for name in [
        "bridge100",
        "vmenet0",
        "docker0",
        "veth1",
        "vnic0",
        "awdl0",
        "llw0",
        "anpi0",
        "ap1",
        "gif0",
        "stf0",
        "utun3",
    ] {
        assert!(!counts_toward_online(name), "{name}");
    }
    for name in ["en0", "en7", "eth0", "wlan0"] {
        assert!(counts_toward_online(name), "{name}");
    }
}

#[test]
fn a_mac_with_only_bridge_addresses_reads_offline() {
    let net = summarize(&[
        entry("bridge100", "192.168.64.1"),
        entry("utun4", "10.8.0.2"),
    ]);
    assert_eq!(
        net,
        LocalNetwork {
            online: false,
            tailscale_up: false,
            lan_up: false,
        }
    );
}

#[test]
fn ipv4_mapped_addresses_classify_as_their_ipv4_address() {
    assert_eq!(
        classify_address(ip("::ffff:100.64.0.1")),
        AddressClass::Tailscale
    );
    assert_eq!(
        classify_address(ip("::ffff:127.0.0.1")),
        AddressClass::Ignored
    );
    assert_eq!(
        classify_address(ip("::ffff:192.168.1.20")),
        AddressClass::Routable
    );
}

fn summary(entries: &[(&str, &str)]) -> LocalNetwork {
    let addresses: Vec<_> = entries
        .iter()
        .map(|(name, addr)| entry(name, addr))
        .collect();
    summarize(&addresses)
}

#[test]
fn a_carrier_nat_address_on_wifi_is_online_and_on_lan_without_tailscale() {
    assert_eq!(
        summary(&[("en0", "100.72.1.5")]),
        LocalNetwork {
            online: true,
            tailscale_up: false,
            lan_up: true,
        }
    );
}

#[test]
fn tailscale_on_utun_beside_a_lan_address_is_online_with_tailscale() {
    assert_eq!(
        summary(&[("utun4", "100.101.2.3"), ("en0", "192.168.1.5")]),
        LocalNetwork {
            online: true,
            tailscale_up: true,
            lan_up: true,
        }
    );
}

#[test]
fn tailscale_alone_is_offline_with_tailscale_up() {
    assert_eq!(
        summary(&[("utun4", "100.101.2.3")]),
        LocalNetwork {
            online: false,
            tailscale_up: true,
            lan_up: false,
        }
    );
}

#[test]
fn linux_tailscale0_counts_as_tailscale_not_online() {
    assert_eq!(
        summary(&[("tailscale0", "fd7a:115c:a1e0::5")]),
        LocalNetwork {
            online: false,
            tailscale_up: true,
            lan_up: false,
        }
    );
}

#[test]
fn cellular_and_tunnels_leave_lan_down_until_a_usable_lan_address_appears() {
    let cellular = ("pdp_ip0", "10.34.12.9");
    let tailnet = ("utun3", "100.72.1.5");
    let cellular_v6 = ("pdp_ip1", "2600:1700::2");
    let vpn = ("utun4", "fd00::1");
    let cellular_only = summary(&[cellular, tailnet, cellular_v6, vpn]);
    assert_eq!(
        cellular_only,
        LocalNetwork {
            online: true,
            tailscale_up: true,
            lan_up: false
        }
    );
    for addr in [
        "192.168.1.5",
        "::ffff:10.0.0.3",
        "fd00::2",
        "2600:1700::3",
        "8.8.4.4",
    ] {
        assert_eq!(
            summary(&[cellular, tailnet, ("en0", addr)]),
            LocalNetwork {
                lan_up: true,
                ..cellular_only
            }
        );
    }
    assert!(!summary(&[("en0", "fe80::2"), ("en0", "ff02::1"),]).lan_up);
}

#[test]
fn hotspot_and_virtual_interfaces_leave_lan_down_until_physical_cgnat_appears() {
    for name in ["bridge100", "vmenet0", "ap1", "anpi0"] {
        assert!(!summary(&[(name, "172.20.10.1")]).lan_up, "{name}");
    }
    assert!(summary(&[("bridge100", "172.20.10.1"), ("en0", "100.72.1.5")]).lan_up);
}
