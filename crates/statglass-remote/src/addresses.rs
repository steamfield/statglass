//! Addresses supplied by the monitored host (D-093, D-155).

use std::io;
use std::net::{IpAddr, Ipv4Addr};
use std::process::Command;
use std::sync::{Arc, Mutex};

use statglass_engine::{ClockReading, IfaceAddrs, LiveHub, continuous_ns, now};
use statglass_proto::{HostAddresses, PublicIp};
use statglass_schema::lock::LockExt;

pub use statglass_engine::{egress_interface, interface_addresses};

const PUBLIC_IP_URL: &str = "https://api.ipify.org";
const PUBLIC_IP_TIMEOUT_SECS: &str = "5";
const SUCCESS_TTL_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
const FAILURE_TTL_NS: u64 = 10 * 60 * 1_000_000_000;
const LOOKUP_INTERRUPTED: &str = "public IP lookup did not finish";

/// One cache per served host, shared by all its clients.
#[derive(Default)]
pub struct AddressResolver {
    cache: Arc<Mutex<Cache>>,
}

#[derive(Clone)]
struct Network {
    primary: Option<String>,
    primary_ipv4: Option<Vec<Ipv4Addr>>,
    egress: Option<String>,
    addrs: IfaceAddrs,
}

impl Network {
    fn read(
        primary: Option<&str>,
        egress: Option<String>,
        read: impl Fn(&str) -> IfaceAddrs,
    ) -> Self {
        let read = |iface| canonical_addresses(read(iface));
        let addrs = egress.as_deref().or(primary).map(read).unwrap_or_default();
        // A tunnel's address can stay put while the LAN underneath it changes.
        let primary_ipv4 = match (primary, egress.as_deref()) {
            (Some(primary), Some(egress)) if primary != egress => Some(read(primary).ipv4),
            _ => None,
        };
        Self {
            primary: primary.map(str::to_owned),
            primary_ipv4,
            egress,
            addrs,
        }
    }

    // IPv6 privacy addresses rotate independently of the route used for this lookup.
    fn same_route(&self, other: &Self) -> bool {
        self.primary == other.primary
            && self.egress == other.egress
            && self.primary_ipv4 == other.primary_ipv4
            && self.addrs.ipv4 == other.addrs.ipv4
    }
}

fn canonical_addresses(mut addrs: IfaceAddrs) -> IfaceAddrs {
    addrs.ipv4.sort_unstable();
    addrs.ipv4.dedup();
    addrs.ipv6.retain(|addr| !addr.is_unicast_link_local());
    addrs.ipv6.sort_unstable();
    addrs.ipv6.dedup();
    addrs
}

#[derive(Default)]
enum Cache {
    #[default]
    Empty,
    // Cleared if a request sees the network change while curl is running. Retain
    // the pending slot until the worker exits, then discard its stale result.
    Pending(Option<Network>),
    Ready {
        network: Network,
        state: PublicIp,
        expires_ns: u64,
    },
}

struct Lookup(Option<Arc<Mutex<Cache>>>);

impl Lookup {
    fn finish(mut self, now_ns: u64, result: Result<IpAddr, PublicIpError>) {
        let state = match result {
            Ok(ip) => PublicIp::Known { ip },
            Err(error) => unavailable(error.to_string()),
        };
        self.settle(now_ns, state);
    }

    fn settle(&mut self, now_ns: u64, state: PublicIp) {
        // Disarm this lookup before publishing. Another request can claim the next slot.
        let Some(cache) = self.0.take() else { return };
        let ttl_ns = match &state {
            PublicIp::Known { .. } => SUCCESS_TTL_NS,
            _ => FAILURE_TTL_NS,
        };
        let mut cache = cache.lock_ok();
        if let Cache::Pending(network) = &mut *cache {
            *cache = network.take().map_or(Cache::Empty, |network| Cache::Ready {
                network,
                state,
                expires_ns: now_ns.saturating_add(ttl_ns),
            });
        }
    }
}

impl Drop for Lookup {
    fn drop(&mut self) {
        if self.0.is_some() {
            self.settle(continuous_ns(), unavailable(LOOKUP_INTERRUPTED));
        }
    }
}

impl AddressResolver {
    /// Reads the host's network and starts curl only when the current answer is missing.
    /// Local reads are synchronous. The request returns before curl finishes.
    pub fn network_addresses(&self, hub: &LiveHub) -> HostAddresses {
        let status = hub.status();
        self.resolve(
            Network::read(
                status.primary_iface.as_deref(),
                egress_interface(),
                interface_addresses,
            ),
            hub,
            now(),
            |lookup| {
                std::thread::Builder::new()
                    .name("statglass-public-ip".into())
                    .spawn(move || {
                        let result = public_ip();
                        lookup.finish(continuous_ns(), result);
                    })
                    .map(drop)
            },
        )
    }

    fn resolve(
        &self,
        network: Network,
        hub: &LiveHub,
        clock: ClockReading,
        spawn: impl FnOnce(Lookup) -> io::Result<()>,
    ) -> HostAddresses {
        let public_ip = self.public_ip_for(&network, clock.continuous_ns, spawn);
        let interface = network.egress.or(network.primary);
        HostAddresses {
            link_mbps: interface
                .as_deref()
                .and_then(|iface| link_mbps(hub, iface, clock.wall_ms)),
            interface,
            ipv4: network.addrs.ipv4,
            ipv6: network.addrs.ipv6,
            public_ip,
            as_of_ms: clock.wall_ms,
        }
    }

    fn public_ip_for(
        &self,
        network: &Network,
        now_ns: u64,
        spawn: impl FnOnce(Lookup) -> io::Result<()>,
    ) -> PublicIp {
        let mut cache = self.cache.lock_ok();
        if network.addrs.ipv4.is_empty() && network.addrs.ipv6.is_empty() {
            // A temporary absence of IPv6 on the same route need not expire the public IP.
            match &mut *cache {
                Cache::Pending(active)
                    if active
                        .as_ref()
                        .is_some_and(|active| !active.same_route(network)) =>
                {
                    *active = None;
                }
                Cache::Ready {
                    network: cached, ..
                } if !cached.same_route(network) => {
                    *cache = Cache::Empty;
                }
                _ => {}
            }
            return unavailable("no local address");
        }
        match &mut *cache {
            Cache::Pending(active) => {
                if active
                    .as_ref()
                    .is_some_and(|active| !active.same_route(network))
                {
                    *active = None;
                }
                return PublicIp::Pending;
            }
            Cache::Ready {
                network: cached,
                state,
                expires_ns,
            } if cached.same_route(network) && now_ns < *expires_ns => return state.clone(),
            _ => {}
        }
        *cache = Cache::Pending(Some(network.clone()));
        drop(cache);

        if let Err(error) = spawn(Lookup(Some(Arc::clone(&self.cache)))) {
            // The failed spawn dropped its closure and settled the pending slot.
            tracing::warn!(
                error = &error as &dyn std::error::Error,
                "starting public IP lookup"
            );
            return unavailable(LOOKUP_INTERRUPTED);
        }
        PublicIp::Pending
    }
}

fn link_mbps(hub: &LiveHub, iface: &str, now_ms: i64) -> Option<u32> {
    let frame = hub.latest_frame()?;
    let index = frame.layout.series.iter().position(|key| {
        key.metric.as_str() == "net.link_rate" && key.labels.get("iface") == Some(iface)
    })?;
    // The last frame may outlive its hold when the host is paused or asleep.
    let age_ms = now_ms.saturating_sub(frame.ts_ms);
    if !(0..=i64::from(*frame.holds.get(index)?)).contains(&age_ms) {
        return None;
    }
    let mbps = (f64::from(*frame.held.get(index)?) / 1_000_000.0).round();
    (1.0..=f64::from(u32::MAX))
        .contains(&mbps)
        .then_some(mbps as u32)
}

fn unavailable(reason: impl Into<String>) -> PublicIp {
    PublicIp::Unavailable {
        reason: reason.into(),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PublicIpError {
    #[error("curl not installed")]
    MissingCurl,
    #[error("could not run curl")]
    Start(#[source] io::Error),
    #[error("could not resolve api.ipify.org")]
    Resolve,
    #[error("could not connect to api.ipify.org")]
    Connect,
    #[error("api.ipify.org returned an HTTP error")]
    Http,
    #[error("public IP lookup timed out")]
    Timeout,
    #[error("could not establish a secure connection to api.ipify.org")]
    Tls,
    #[error("could not verify the TLS certificate for api.ipify.org")]
    Certificate,
    #[error("curl could not read the public IP")]
    CurlFailed,
    #[error("response is not text")]
    InvalidText,
    #[error("response is not an address")]
    InvalidAddress,
}

/// The public address as seen by ipify. Blocking, for use on a worker thread.
pub fn public_ip() -> Result<IpAddr, PublicIpError> {
    lookup_with(|command| command.output())
}

fn lookup_with(
    run: impl FnOnce(&mut Command) -> io::Result<std::process::Output>,
) -> Result<IpAddr, PublicIpError> {
    let mut command = Command::new("/usr/bin/curl");
    command.args([
        "-q",
        "--silent",
        "--fail",
        "--max-time",
        PUBLIC_IP_TIMEOUT_SECS,
        PUBLIC_IP_URL,
    ]);
    let out = run(&mut command).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => PublicIpError::MissingCurl,
        _ => PublicIpError::Start(error),
    })?;
    if !out.status.success() {
        tracing::debug!(status = %out.status, "curl public IP lookup failed");
        return Err(match out.status.code() {
            Some(6) => PublicIpError::Resolve,
            Some(7) => PublicIpError::Connect,
            Some(22) => PublicIpError::Http,
            Some(28) => PublicIpError::Timeout,
            Some(35) => PublicIpError::Tls,
            Some(60) => PublicIpError::Certificate,
            _ => PublicIpError::CurlFailed,
        });
    }
    parse_ip(&out.stdout)
}

fn parse_ip(body: &[u8]) -> Result<IpAddr, PublicIpError> {
    let text = std::str::from_utf8(body).map_err(|_| PublicIpError::InvalidText)?;
    text.trim()
        .parse()
        .map_err(|_| PublicIpError::InvalidAddress)
}

#[cfg(test)]
mod tests {
    use super::*;
    use statglass_engine::{BusMsg, FrameLayout, LiveFrame};
    use statglass_schema::SeriesKey;

    struct Resolver {
        resolver: AddressResolver,
        hub: LiveHub,
        now_ns: u64,
        wall_ms: i64,
        spawns: usize,
        pending: Option<Lookup>,
    }

    impl Resolver {
        fn new() -> Self {
            Self {
                resolver: AddressResolver::default(),
                hub: LiveHub::default(),
                now_ns: 0,
                wall_ms: 123_456,
                spawns: 0,
                pending: None,
            }
        }

        fn answer(&mut self, network: Network) -> HostAddresses {
            let clock = ClockReading {
                wall_ms: self.wall_ms,
                continuous_ns: self.now_ns,
            };
            self.resolver.resolve(network, &self.hub, clock, |lookup| {
                assert!(
                    self.pending.replace(lookup).is_none(),
                    "curl already running"
                );
                self.spawns += 1;
                Ok(())
            })
        }

        fn finish_curl(&mut self, result: Result<IpAddr, PublicIpError>) {
            self.pending
                .take()
                .expect("a pending curl")
                .finish(self.now_ns, result);
        }

        fn advance(&mut self, secs: u64) {
            self.now_ns += secs * 1_000_000_000;
        }
    }

    fn network() -> Network {
        Network {
            primary: Some("en0".into()),
            primary_ipv4: None,
            egress: Some("utun3".into()),
            addrs: IfaceAddrs {
                ipv4: vec![[192, 0, 2, 10].into()],
                ipv6: vec!["2001:db8::1".parse().expect("test IPv6")],
            },
        }
    }

    fn ip() -> IpAddr {
        [203, 0, 113, 7].into()
    }

    #[test]
    fn addresses_wait_for_a_local_address() {
        let mut resolver = Resolver::new();
        for primary in [None, Some("en0")] {
            let empty = Network::read(primary, None, |_| IfaceAddrs::default());
            let answer = resolver.answer(empty);
            assert_eq!(answer.interface.as_deref(), primary);
            assert!(answer.ipv4.is_empty() && answer.ipv6.is_empty());
            assert_eq!(answer.public_ip, unavailable("no local address"));
        }
        assert_eq!(resolver.spawns, 0);
        assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
        assert_eq!(resolver.spawns, 1);
    }

    #[test]
    fn addresses_prefer_egress_and_report_its_held_link_speed_and_addresses() {
        let mut resolver = Resolver::new();
        let series = [
            SeriesKey::parse("net.link_rate{iface=en0}").unwrap(),
            SeriesKey::parse("net.link_rate{iface=utun3}").unwrap(),
        ];
        resolver.hub.publish(BusMsg::Frame(Arc::new(LiveFrame {
            ts_ms: 123_000,
            interval_ms: 1000,
            layout: Arc::new(FrameLayout {
                layout_no: 1,
                series: series.into(),
            }),
            timeline: 0,
            values: [f32::NAN; 2].into(),
            held: [1_000_000_000.0, 866_700_000.0].into(),
            holds: [150_000; 2].into(),
        })));
        for (egress, iface, rate) in [
            (Some("utun3"), "utun3", Some(867)),
            (None, "en0", Some(1000)),
            (Some("eth0"), "eth0", None),
        ] {
            let input = Network::read(Some("en0"), egress.map(str::to_owned), |name| {
                assert!(name == iface || name == "en0");
                IfaceAddrs {
                    ipv4: vec![if name == iface {
                        [192, 0, 2, 10].into()
                    } else {
                        [198, 51, 100, 10].into()
                    }],
                    ipv6: vec!["fe80::1".parse().unwrap(), "2001:db8::1".parse().unwrap()],
                }
            });
            assert_eq!(
                resolver.answer(input),
                HostAddresses {
                    interface: Some(iface.into()),
                    link_mbps: rate,
                    ipv4: network().addrs.ipv4,
                    ipv6: network().addrs.ipv6,
                    public_ip: PublicIp::Pending,
                    as_of_ms: 123_456,
                }
            );
        }
        resolver.wall_ms += 150_000;
        assert_eq!(resolver.answer(network()).link_mbps, None);
    }

    #[test]
    fn addresses_share_a_pending_lookup_and_cache_success_for_24_hours() {
        let mut resolver = Resolver::new();
        for _ in 0..2 {
            assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
        }
        assert_eq!(resolver.spawns, 1);
        resolver.advance(5);
        resolver.finish_curl(Ok(ip()));
        resolver.advance(23 * 3600 + 59 * 60);
        assert_eq!(
            resolver.answer(network()).public_ip,
            PublicIp::Known { ip: ip() }
        );
        assert_eq!(resolver.spawns, 1);
        resolver.advance(60);
        assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
        assert_eq!(resolver.spawns, 2);
    }

    #[test]
    fn addresses_retry_an_abandoned_lookup_after_the_failure_ttl() {
        let mut resolver = Resolver::new();
        assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
        // Bracket the drop's continuous clock, then drive the request clock without waiting.
        let before = continuous_ns();
        drop(resolver.pending.take().unwrap());
        let after = continuous_ns();
        resolver.now_ns = before;
        resolver.advance(599);
        assert_eq!(
            resolver.answer(network()).public_ip,
            unavailable("public IP lookup did not finish")
        );
        assert_eq!(resolver.spawns, 1);
        resolver.now_ns = after;
        resolver.advance(600);
        assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
        assert_eq!(resolver.spawns, 2);
    }

    #[test]
    fn addresses_report_rotated_ipv6_without_refreshing_the_public_ip() {
        let read = |primary: Option<_>, egress| {
            Network::read(Some("en0"), Some("utun3".into()), |iface| IfaceAddrs {
                ipv4: Vec::new(),
                ipv6: if iface == "en0" { primary } else { egress }
                    .into_iter()
                    .collect(),
            })
        };
        let first = "2001:db8::1".parse().unwrap();
        let rotated = "2001:db8::2".parse().unwrap();
        let mut resolver = Resolver::new();
        assert_eq!(
            resolver.answer(read(Some(first), Some(first))).public_ip,
            PublicIp::Pending
        );
        // Rotation during the lookup also leaves it valid.
        assert_eq!(
            resolver.answer(read(Some(rotated), Some(first))).public_ip,
            PublicIp::Pending
        );
        resolver.finish_curl(Ok(ip()));
        assert_eq!(
            resolver.answer(read(Some(rotated), None)).public_ip,
            unavailable("no local address")
        );
        let answer = resolver.answer(read(Some(rotated), Some(rotated)));
        assert_eq!(answer.ipv6, [rotated]);
        assert_eq!(answer.public_ip, PublicIp::Known { ip: ip() });
        assert_eq!(resolver.spawns, 1);
    }

    #[test]
    fn addresses_refresh_when_the_local_ip_primary_or_egress_changes() {
        for changed in [
            Network {
                addrs: IfaceAddrs {
                    ipv4: vec![[192, 0, 2, 11].into()],
                    ..network().addrs
                },
                ..network()
            },
            Network {
                primary: Some("en7".into()),
                ..network()
            },
            Network {
                egress: None,
                ..network()
            },
        ] {
            let mut resolver = Resolver::new();
            assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
            resolver.finish_curl(Ok(ip()));
            assert_eq!(
                resolver.answer(network()).public_ip,
                PublicIp::Known { ip: ip() }
            );
            resolver.advance(1);
            assert_eq!(resolver.answer(changed).public_ip, PublicIp::Pending);
            assert_eq!(resolver.spawns, 2);
        }
    }

    #[test]
    fn addresses_discard_the_result_if_the_network_changes_during_curl() {
        let mut resolver = Resolver::new();
        assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
        let new_network = Network {
            egress: None,
            ..network()
        };
        assert_eq!(resolver.answer(new_network).public_ip, PublicIp::Pending);
        assert_eq!(resolver.spawns, 1);
        resolver.finish_curl(Ok(ip()));
        // The host returned to the original interface before the next request.
        assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
        assert_eq!(resolver.spawns, 2);
    }

    #[test]
    fn addresses_refresh_when_the_primary_address_changes_behind_the_same_egress() {
        let network = |last| {
            Network::read(Some("en0"), Some("utun3".into()), |iface| IfaceAddrs {
                ipv4: vec![if iface == "en0" {
                    [192, 0, 2, last].into()
                } else {
                    [10, 0, 0, 1].into()
                }],
                ipv6: Vec::new(),
            })
        };
        let mut resolver = Resolver::new();
        assert_eq!(resolver.answer(network(10)).public_ip, PublicIp::Pending);
        resolver.finish_curl(Ok(ip()));
        assert_eq!(
            resolver.answer(network(10)).public_ip,
            PublicIp::Known { ip: ip() }
        );
        let answer = resolver.answer(network(11));
        assert_eq!(answer.ipv4, vec![std::net::Ipv4Addr::new(10, 0, 0, 1)]);
        assert_eq!(answer.public_ip, PublicIp::Pending);
        assert_eq!(resolver.spawns, 2);
    }

    #[test]
    fn addresses_report_missing_system_curl_and_cache_failure_for_ten_minutes() {
        let mut resolver = Resolver::new();
        assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
        resolver.finish_curl(lookup_with(|command| {
            assert_eq!(command.get_program(), "/usr/bin/curl");
            let args = command.get_args().collect::<Vec<_>>();
            assert!(args.contains(&std::ffi::OsStr::new("https://api.ipify.org")));
            assert!(args.windows(2).any(|pair| pair == ["--max-time", "5"]));
            assert!(!args.contains(&std::ffi::OsStr::new("--noproxy")));
            assert!(command.get_envs().all(|(name, _)| {
                !matches!(
                    name.to_str(),
                    Some("https_proxy" | "HTTPS_PROXY" | "all_proxy" | "ALL_PROXY")
                )
            }));
            Err(io::ErrorKind::NotFound.into())
        }));
        for _ in 0..599 {
            assert_eq!(
                resolver.answer(network()).public_ip,
                unavailable("curl not installed")
            );
            resolver.advance(1);
        }
        assert_eq!(resolver.spawns, 1);
        assert_eq!(
            resolver.answer(network()).public_ip,
            unavailable("curl not installed")
        );
        resolver.advance(1);
        assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
        assert_eq!(resolver.spawns, 2);
    }

    #[test]
    fn addresses_cache_a_curl_timeout_without_exposing_its_stderr() {
        use std::os::unix::process::ExitStatusExt;
        let mut resolver = Resolver::new();
        assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
        resolver.finish_curl(lookup_with(|_| {
            Ok(std::process::Output {
                status: std::process::ExitStatus::from_raw(28 << 8),
                stdout: Vec::new(),
                stderr: b"curl: timed out connecting to private.example".to_vec(),
            })
        }));
        resolver.advance(599);
        assert_eq!(
            resolver.answer(network()).public_ip,
            unavailable("public IP lookup timed out")
        );
        assert_eq!(resolver.spawns, 1);
        resolver.advance(1);
        assert_eq!(resolver.answer(network()).public_ip, PublicIp::Pending);
    }

    #[test]
    fn addresses_explain_curl_exit_codes_without_exposing_raw_output() {
        use std::os::unix::process::ExitStatusExt;
        let actual: Vec<_> = [6, 7, 22, 28, 35, 60, 99]
            .into_iter()
            .map(|code| {
                lookup_with(|_| {
                    Ok(std::process::Output {
                        status: std::process::ExitStatus::from_raw(code << 8),
                        stdout: Vec::new(),
                        stderr: b"curl: private proxy name".to_vec(),
                    })
                })
                .unwrap_err()
                .to_string()
            })
            .collect();
        assert_eq!(
            actual,
            [
                "could not resolve api.ipify.org",
                "could not connect to api.ipify.org",
                "api.ipify.org returned an HTTP error",
                "public IP lookup timed out",
                "could not establish a secure connection to api.ipify.org",
                "could not verify the TLS certificate for api.ipify.org",
                "curl could not read the public IP",
            ]
        );
    }

    #[test]
    fn addresses_accept_bare_public_ips_and_reject_non_addresses() {
        assert_eq!(parse_ip(b"203.0.113.7\n").unwrap(), ip());
        assert_eq!(parse_ip(b"2001:db8::1").unwrap(), network().addrs.ipv6[0]);
        for response in [b"<html>Sign in to Wi-Fi</html>".as_slice(), b""] {
            assert!(matches!(
                parse_ip(response),
                Err(PublicIpError::InvalidAddress)
            ));
        }
        assert!(matches!(parse_ip(&[0xff]), Err(PublicIpError::InvalidText)));
    }
}
