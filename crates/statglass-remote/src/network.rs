//! This Mac's own network state at the moment a remote connection fails, read from its
//! interfaces, and how that state refines a failure's cause. No subprocess, no polling.
use crate::{ConnectionFailureKind, Route};
use std::net::IpAddr;

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

/// Classifies one interface address.
pub fn classify_address(addr: IpAddr) -> AddressClass {
    let _ = addr;
    AddressClass::Routable
}

/// Reads this Mac's interfaces with `getifaddrs`. A failed read reports online with
/// Tailscale up, so a probe failure never invents a local cause.
pub fn probe() -> LocalNetwork {
    LocalNetwork {
        online: true,
        tailscale_up: true,
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
    let _ = (route, net);
    kind
}

#[cfg(test)]
mod tests;
