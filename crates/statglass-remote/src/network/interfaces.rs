//! The `getifaddrs` walk: the IP addresses on this Mac's usable interfaces, with the
//! name of each interface. All of the network module's unsafe FFI lives here.
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

/// The IP address in a `sockaddr`, or `None` for null and non-IP families (AF_LINK).
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
