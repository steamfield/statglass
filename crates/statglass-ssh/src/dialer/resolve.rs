use statglass_session::{RemoteError, UnreachableKind};
use std::net::SocketAddr;

pub(crate) async fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, RemoteError> {
    let addresses = lookup(host, port).await?;
    if addresses.is_empty() {
        return Err(RemoteError::Unreachable {
            kind: UnreachableKind::NameNotResolved,
            detail: format!("{host}: SSH name lookup returned no addresses"),
        });
    }
    Ok(addresses)
}

fn lookup_error(host: &str, error: impl std::fmt::Display) -> RemoteError {
    RemoteError::Unreachable {
        kind: UnreachableKind::NameNotResolved,
        detail: format!("{host}: SSH name lookup: {error}"),
    }
}

#[cfg(not(target_vendor = "apple"))]
async fn lookup(host: &str, port: u16) -> Result<Vec<SocketAddr>, RemoteError> {
    Ok(tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| lookup_error(host, error))?
        .collect())
}

#[cfg(target_vendor = "apple")]
use apple::lookup;

#[cfg(target_vendor = "apple")]
mod apple {
    use super::{RemoteError, SocketAddr, lookup_error};
    use std::{
        ffi::{CStr, CString},
        io,
        mem::size_of,
        net::{Ipv4Addr, Ipv6Addr, SocketAddrV6},
        ptr::{self, NonNull},
    };

    pub(super) async fn lookup(host: &str, port: u16) -> Result<Vec<SocketAddr>, RemoteError> {
        let name = host.to_owned();
        tokio::task::spawn_blocking(move || lookup_blocking(&name, port))
            .await
            .map_err(|error| lookup_error(host, error))?
    }

    fn lookup_blocking(host: &str, port: u16) -> Result<Vec<SocketAddr>, RemoteError> {
        let name = CString::new(host).map_err(|error| lookup_error(host, error))?;
        let service = CString::new(port.to_string()).map_err(|error| lookup_error(host, error))?;
        // Darwin can synthesize an IPv6 address for an IPv4 literal on DNS64/NAT64.
        // Use the same resolver path for names and literals so synthesis can occur.
        let hints = libc::addrinfo {
            ai_flags: libc::AI_DEFAULT,
            ai_family: libc::AF_UNSPEC,
            ai_socktype: libc::SOCK_STREAM,
            ai_protocol: 0,
            ai_addrlen: 0,
            ai_canonname: ptr::null_mut(),
            ai_addr: ptr::null_mut(),
            ai_next: ptr::null_mut(),
        };
        let mut head = ptr::null_mut();
        // SAFETY: name and service are NUL-terminated, hints is initialized, and head
        // is a writable out pointer. All inputs remain live for the call.
        let status =
            unsafe { libc::getaddrinfo(name.as_ptr(), service.as_ptr(), &hints, &mut head) };
        match status {
            0 => Ok(NonNull::new(head)
                .map(AddressList)
                .map_or_else(Vec::new, |list| list.addresses())),
            libc::EAI_SYSTEM => Err(lookup_error(host, io::Error::last_os_error())),
            _ => {
                // SAFETY: Darwin's gai_strerror returns a static NUL-terminated string.
                let message = unsafe { CStr::from_ptr(libc::gai_strerror(status)) };
                Err(lookup_error(host, message.to_string_lossy()))
            }
        }
    }

    struct AddressList(NonNull<libc::addrinfo>);

    impl AddressList {
        fn addresses(&self) -> Vec<SocketAddr> {
            let mut addresses = Vec::new();
            let mut current = Some(self.0);
            while let Some(node) = current {
                // SAFETY: getaddrinfo allocated this node and its linked successors.
                // The list remains live for this whole traversal.
                let entry = unsafe { node.as_ref() };
                if let Some(address) = socket_address(entry) {
                    addresses.push(address);
                }
                current = NonNull::new(entry.ai_next);
            }
            addresses
        }
    }

    impl Drop for AddressList {
        fn drop(&mut self) {
            // SAFETY: this is the list head returned by getaddrinfo and its only owner.
            unsafe { libc::freeaddrinfo(self.0.as_ptr()) };
        }
    }

    fn socket_address(entry: &libc::addrinfo) -> Option<SocketAddr> {
        let address = NonNull::new(entry.ai_addr)?;
        let len = entry.ai_addrlen as usize;
        match entry.ai_family {
            libc::AF_INET if len >= size_of::<libc::sockaddr_in>() => {
                // SAFETY: the live getaddrinfo entry identifies a full sockaddr_in.
                let address = unsafe { address.cast::<libc::sockaddr_in>().as_ref() };
                let ip = Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes());
                Some(SocketAddr::from((ip, u16::from_be(address.sin_port))))
            }
            libc::AF_INET6 if len >= size_of::<libc::sockaddr_in6>() => {
                // SAFETY: the live getaddrinfo entry identifies a full sockaddr_in6.
                let address = unsafe { address.cast::<libc::sockaddr_in6>().as_ref() };
                Some(SocketAddr::V6(SocketAddrV6::new(
                    Ipv6Addr::from(address.sin6_addr.s6_addr),
                    u16::from_be(address.sin6_port),
                    address.sin6_flowinfo,
                    address.sin6_scope_id,
                )))
            }
            _ => None,
        }
    }
}

#[cfg(all(test, target_vendor = "apple"))]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[tokio::test]
    async fn resolves_ipv4_loopback_with_the_requested_port() {
        let addresses = resolve("127.0.0.1", 23456).await.unwrap();
        assert_eq!(addresses, [SocketAddr::from((Ipv4Addr::LOCALHOST, 23456))]);
    }

    #[tokio::test]
    async fn resolves_ipv6_loopback_with_the_requested_port() {
        let addresses = resolve("::1", 23456).await.unwrap();
        assert_eq!(addresses, [SocketAddr::from((Ipv6Addr::LOCALHOST, 23456))]);
    }

    #[tokio::test]
    async fn resolves_a_hostname_to_loopback_addresses() {
        let addresses = resolve("localhost", 23456).await.unwrap();
        assert!(!addresses.is_empty());
        assert!(
            addresses
                .iter()
                .all(|address| address.ip().is_loopback() && address.port() == 23456),
            "{addresses:?}"
        );
    }
}
