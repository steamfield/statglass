//! This Mac's own network state at the moment a remote connection fails, read from its
//! interfaces, and how that state refines a failure's cause. No subprocess, no polling.
use crate::{ConnectionFailureKind, Route};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// What this Mac's interfaces said when a connection attempt failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalNetwork {
    /// An up, running interface that [`counts_toward_online`] has a routable address.
    pub online: bool,
    /// An up, running Tailscale interface (`utun*`, `tailscale*`) has a Tailscale
    /// address (100.64.0.0/10 or fd7a:115c:a1e0::/48).
    pub tailscale_up: bool,
    /// A route to the host's LAN may exist: an up interface other than cellular
    /// (`pdp_ip*`) and tunnels (`utun*`) has a usable address. Cellular alone counts as
    /// LAN-down. Until phase 3 lane c refines it, `summarize` sets it to `online`.
    pub lan_up: bool,
}

/// How one interface address counts toward [`LocalNetwork`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressClass {
    Tailscale,
    Routable,
    /// Loopback, link-local, unspecified or otherwise not a way off this Mac.
    Ignored,
}

/// What a failed interface read reports: it never invents a local cause.
const UNKNOWN_NETWORK: LocalNetwork = LocalNetwork {
    online: true,
    tailscale_up: true,
    lan_up: true,
};

/// Tailscale's IPv6 ULA prefix, fd7a:115c:a1e0::/48, as its first three segments.
const TAILSCALE_V6_PREFIX: [u16; 3] = [0xfd7a, 0x115c, 0xa1e0];

/// Name prefixes of interfaces that never take this Mac off its own machine: VM and
/// container bridges (OrbStack, Docker, UTM), Apple's peer-to-peer links, tunnels and
/// VPN interfaces (`utun`, Linux `tailscale0`). Their addresses say nothing about
/// whether the Mac is online.
const NOT_ONLINE_PREFIXES: [&str; 13] = [
    "bridge",
    "vmenet",
    "docker",
    "veth",
    "vnic",
    "awdl",
    "llw",
    "anpi",
    "ap",
    "gif",
    "stf",
    "utun",
    "tailscale",
];

/// Name prefixes of interfaces Tailscale runs on: `utun` on macOS, `tailscale0` on Linux.
const TAILSCALE_INTERFACE_PREFIXES: [&str; 2] = ["utun", "tailscale"];

/// Classifies one interface address. An IPv4-mapped IPv6 address is classified as its
/// IPv4 address.
pub fn classify_address(addr: IpAddr) -> AddressClass {
    match addr.to_canonical() {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

fn classify_v4(addr: Ipv4Addr) -> AddressClass {
    if addr.is_loopback() || addr.is_unspecified() || addr.is_link_local() {
        return AddressClass::Ignored;
    }
    // Tailscale hands out addresses from the CGNAT range 100.64.0.0/10.
    let [first, second, ..] = addr.octets();
    if first == 100 && (second & 0xc0) == 64 {
        return AddressClass::Tailscale;
    }
    AddressClass::Routable
}

fn classify_v6(addr: Ipv6Addr) -> AddressClass {
    let segments = addr.segments();
    let link_local = (segments[0] & 0xffc0) == 0xfe80;
    if addr.is_loopback() || addr.is_unspecified() || link_local {
        return AddressClass::Ignored;
    }
    if segments[..3] == TAILSCALE_V6_PREFIX {
        return AddressClass::Tailscale;
    }
    AddressClass::Routable
}

/// Whether a routable address on the interface named `name` means this Mac is online.
pub fn counts_toward_online(name: &str) -> bool {
    !has_prefix(name, &NOT_ONLINE_PREFIXES)
}

fn has_prefix(name: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|prefix| name.starts_with(prefix))
}

/// Reads this Mac's interfaces with `getifaddrs`. A failed read is logged and reports
/// online with Tailscale up, so a probe failure never invents a local cause.
pub fn probe() -> LocalNetwork {
    match interfaces::usable_addresses() {
        Ok(addresses) => summarize(&addresses),
        Err(error) => {
            tracing::warn!(%error, "could not read this Mac's network interfaces");
            UNKNOWN_NETWORK
        }
    }
}

/// Folds the addresses of up, running, non-loopback interfaces into a [`LocalNetwork`].
fn summarize(addresses: &[interfaces::InterfaceAddress]) -> LocalNetwork {
    let mut net = LocalNetwork {
        online: false,
        tailscale_up: false,
        lan_up: false,
    };
    for entry in addresses {
        match class_on_interface(entry) {
            AddressClass::Tailscale => net.tailscale_up = true,
            AddressClass::Routable if counts_toward_online(&entry.name) => net.online = true,
            AddressClass::Routable | AddressClass::Ignored => {}
        }
    }
    net.lan_up = net.online;
    net
}

/// How an address counts given the interface carrying it. ISPs, hotspots and corporate
/// networks hand out carrier-grade NAT addresses from Tailscale's 100.64.0.0/10 too, so
/// a Tailscale-range address means Tailscale only on a Tailscale interface.
fn class_on_interface(entry: &interfaces::InterfaceAddress) -> AddressClass {
    match classify_address(entry.addr) {
        AddressClass::Tailscale if !has_prefix(&entry.name, &TAILSCALE_INTERFACE_PREFIXES) => {
            AddressClass::Routable
        }
        class => class,
    }
}

/// Refines one route's failure with this Mac's network state: offline turns network
/// failures into [`ConnectionFailureKind::LocalOffline`] (except a refusal, which proves
/// a host answered), and a Tailscale route with Tailscale down becomes
/// [`ConnectionFailureKind::TailscaleDown`]. Non-network kinds are returned unchanged.
pub fn refine(
    kind: ConnectionFailureKind,
    route: Route,
    net: LocalNetwork,
) -> ConnectionFailureKind {
    if !is_network_kind(kind) || kind == ConnectionFailureKind::Refused {
        return kind;
    }
    if !net.online {
        return ConnectionFailureKind::LocalOffline;
    }
    if route == Route::Tailscale && !net.tailscale_up {
        return ConnectionFailureKind::TailscaleDown;
    }
    kind
}

/// Whether a failure is about reaching the host at all, so this Mac's network can
/// explain it.
pub(crate) fn is_network_kind(kind: ConnectionFailureKind) -> bool {
    matches!(
        kind,
        ConnectionFailureKind::NameNotResolved
            | ConnectionFailureKind::Refused
            | ConnectionFailureKind::NoRoute
            | ConnectionFailureKind::Timeout
            | ConnectionFailureKind::Unreachable
    )
}

mod interfaces;

#[cfg(test)]
mod tests;
