//! This Mac's own network state at the moment a remote connection fails, read from its
//! interfaces, and how that state refines a failure's cause. No subprocess, no polling.
use crate::{ConnectionFailureKind, Route};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// What this Mac's interfaces said when a connection attempt failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalNetwork {
    /// An up, running, non-loopback interface has a routable address that is not
    /// Tailscale's.
    pub online: bool,
    /// An up, running interface has a Tailscale address (100.64.0.0/10 or
    /// fd7a:115c:a1e0::/48).
    pub tailscale_up: bool,
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
};

/// Tailscale's IPv6 ULA prefix, fd7a:115c:a1e0::/48, as its first three segments.
const TAILSCALE_V6_PREFIX: [u16; 3] = [0xfd7a, 0x115c, 0xa1e0];

/// Name prefixes of interfaces that never take this Mac off its own machine: VM and
/// container bridges (OrbStack, Docker, UTM), Apple's peer-to-peer links, tunnels and
/// `utun` VPN interfaces. Their addresses say nothing about whether the Mac is online.
const NOT_ONLINE_PREFIXES: [&str; 12] = [
    "bridge", "vmenet", "docker", "veth", "vnic", "awdl", "llw", "anpi", "ap", "gif", "stf", "utun",
];

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
    !NOT_ONLINE_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
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
/// Tailscale counts on any interface; a routable address counts only on an interface
/// that [`counts_toward_online`].
fn summarize(addresses: &[interfaces::InterfaceAddress]) -> LocalNetwork {
    let mut net = LocalNetwork {
        online: false,
        tailscale_up: false,
    };
    for entry in addresses {
        match classify_address(entry.addr) {
            AddressClass::Routable if counts_toward_online(&entry.name) => net.online = true,
            AddressClass::Routable | AddressClass::Ignored => {}
            AddressClass::Tailscale => net.tailscale_up = true,
        }
    }
    net
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

/// The `getifaddrs` FFI, kept apart from the pure classification above.
mod interfaces {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    /// Flags an interface needs before its addresses count.
    const REQUIRED_FLAGS: libc::c_uint = (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_uint;
    const LOOPBACK_FLAG: libc::c_uint = libc::IFF_LOOPBACK as libc::c_uint;

    /// One IP address and the name of the interface that carries it.
    pub(super) struct InterfaceAddress {
        pub(super) name: String,
        pub(super) addr: IpAddr,
    }

    /// Owns a `getifaddrs` list and frees it on drop, so every return path releases it.
    struct InterfaceList(*mut libc::ifaddrs);

    impl Drop for InterfaceList {
        fn drop(&mut self) {
            // SAFETY: the pointer came from a successful getifaddrs call and is freed
            // exactly once, here.
            unsafe { libc::freeifaddrs(self.0) };
        }
    }

    /// The IP addresses on interfaces that are up, running and not loopback.
    ///
    /// # Errors
    /// Returns the OS error when `getifaddrs` fails.
    pub(super) fn usable_addresses() -> std::io::Result<Vec<InterfaceAddress>> {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        // SAFETY: getifaddrs writes a list head into a valid out-pointer and reports
        // failure with -1 and errno, leaving nothing to free.
        if unsafe { libc::getifaddrs(&mut head) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let list = InterfaceList(head);
        let mut addresses = Vec::new();
        let mut cursor = list.0;
        while !cursor.is_null() {
            // SAFETY: cursor is a non-null node of the list `list` keeps alive.
            let entry = unsafe { &*cursor };
            if interface_counts(entry.ifa_flags)
                && let Some(addr) = ip_of(entry.ifa_addr)
            {
                addresses.push(InterfaceAddress {
                    name: name_of(entry.ifa_name),
                    addr,
                });
            }
            cursor = entry.ifa_next;
        }
        Ok(addresses)
    }

    fn interface_counts(flags: libc::c_uint) -> bool {
        flags & REQUIRED_FLAGS == REQUIRED_FLAGS && flags & LOOPBACK_FLAG == 0
    }

    /// The interface's name, or empty when the list has none for it.
    fn name_of(name: *const libc::c_char) -> String {
        if name.is_null() {
            return String::new();
        }
        // SAFETY: name is non-null and getifaddrs gives each node a NUL-terminated name
        // that lives as long as the list.
        unsafe { std::ffi::CStr::from_ptr(name) }
            .to_string_lossy()
            .into_owned()
    }

    /// The IP address in a `sockaddr`, or `None` for null and non-IP families.
    fn ip_of(addr: *const libc::sockaddr) -> Option<IpAddr> {
        if addr.is_null() {
            return None;
        }
        // SAFETY: addr is non-null and points into the live getifaddrs list; sa_family
        // says which concrete sockaddr type it is, and we only cast to that one.
        unsafe {
            match i32::from((*addr).sa_family) {
                libc::AF_INET => {
                    let v4 = &*addr.cast::<libc::sockaddr_in>();
                    Some(IpAddr::V4(Ipv4Addr::from(u32::from_be(v4.sin_addr.s_addr))))
                }
                libc::AF_INET6 => {
                    let v6 = &*addr.cast::<libc::sockaddr_in6>();
                    Some(IpAddr::V6(Ipv6Addr::from(v6.sin6_addr.s6_addr)))
                }
                _ => None,
            }
        }
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod extra_tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
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
                tailscale_up: false
            }
        );
    }

    #[test]
    fn tailscale_counts_on_a_utun_interface_and_wifi_counts_as_online() {
        let net = summarize(&[entry("utun5", "100.101.1.2"), entry("en0", "192.168.1.20")]);
        assert_eq!(
            net,
            LocalNetwork {
                online: true,
                tailscale_up: true
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
}
