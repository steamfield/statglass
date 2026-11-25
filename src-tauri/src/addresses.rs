//! The Network page's address line: the primary interface's addresses, read locally,
//! and the public address, which only a server outside the Mac can see (D-093).

use std::net::IpAddr;

use crate::ipc::NetworkAddresses;
use statglass_remote::addresses;

/// The addresses of `iface`, the interface carrying the default route.
pub fn network_addresses(iface: Option<&str>) -> NetworkAddresses {
    let addrs = iface
        .map(addresses::interface_addresses)
        .unwrap_or_default();
    NetworkAddresses {
        iface: iface.map(str::to_owned),
        ipv4: addrs.ipv4.iter().map(ToString::to_string).collect(),
        ipv6: addrs.ipv6.iter().map(ToString::to_string).collect(),
        egress: addresses::egress_interface(),
    }
}

/// The legacy local command runs the shared lookup off the main thread.
pub fn public_ip() -> Result<IpAddr, String> {
    addresses::public_ip().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_primary_interface_reads_no_addresses() {
        let a = network_addresses(None);
        assert_eq!(a.iface, None);
        assert!(a.ipv4.is_empty() && a.ipv6.is_empty());
    }
}
