//! Addresses supplied by the monitored host.

use statglass_proto::HostAddresses;

pub fn network_addresses() -> HostAddresses {
    HostAddresses::unavailable("not implemented")
}
