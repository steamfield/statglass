//! OpenSSH configuration and host keys for handover.

use std::{
    collections::BTreeMap,
    net::IpAddr,
    path::{Path, PathBuf},
    process::Command,
};

use statglass_proto::{
    handover::HandoverReason,
    pairing::{BundleHost, BundleHostKey, BundleRoute, BundleTarget},
};
use statglass_schema::HostId;
use statglass_session::network::{AddressClass, classify_address};

use crate::effective_user::EffectiveUser;

mod host_keys;
mod process;
use host_keys::{HostKeys, search};

pub struct ResolvedAlias {
    pub hostname: String,
    pub user: String,
    pub port: u16,
    pub proxy_jump: Option<String>,
    pub proxy_command: Option<String>,
}

pub fn parse_ssh_g(output: &str) -> Result<ResolvedAlias, SshConfigError> {
    alias_fields(&config_fields(output))
}

fn config_fields(output: &str) -> BTreeMap<&str, &str> {
    output
        .lines()
        .filter_map(|line| {
            let (key, value) = line.trim().split_once(char::is_whitespace)?;
            Some((key, value.trim()))
        })
        .collect()
}

fn alias_fields(fields: &BTreeMap<&str, &str>) -> Result<ResolvedAlias, SshConfigError> {
    let value = |key| {
        fields
            .get(key)
            .copied()
            .filter(|&value| !value.is_empty() && value != "none")
    };
    let required =
        |key| value(key).ok_or_else(|| SshConfigError::Resolve(format!("missing {key}")));
    let port = required("port")?
        .parse::<u16>()
        .ok()
        .filter(|&port| port != 0)
        .ok_or_else(|| SshConfigError::Resolve("invalid port".into()))?;
    Ok(ResolvedAlias {
        hostname: required("hostname")?.into(),
        user: required("user")?.into(),
        port,
        proxy_jump: value("proxyjump").map(str::to_owned),
        proxy_command: value("proxycommand").map(str::to_owned),
    })
}

pub fn resolve(alias: &str, config: Option<&Path>) -> Result<ResolvedAlias, SshConfigError> {
    parse_ssh_g(&ssh_g(alias, config)?)
}

fn ssh_g(alias: &str, config: Option<&Path>) -> Result<String, SshConfigError> {
    let mut command = Command::new("/usr/bin/ssh");
    command.args(["-G", "-T"]);
    if let Some(config) = config {
        command.arg("-F").arg(config);
    }
    command.args(["--", alias]);
    let output = process::output(command, None)?;
    if !output.status.success() {
        return Err(SshConfigError::Resolve(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        ));
    }
    String::from_utf8(output.stdout).map_err(|error| SshConfigError::Resolve(error.to_string()))
}

pub fn known_host_keys(
    host: &str,
    port: u16,
    known_hosts: Option<&Path>,
) -> Result<Vec<BundleHostKey>, SshConfigError> {
    let files = match known_hosts {
        Some(path) => vec![path.to_path_buf()],
        None => default_key_files(&EffectiveUser::lookup()?.home),
    };
    Ok(keys_for_host(host, port, None, &files)?.trusted())
}

pub fn handover_host(
    remote: &HandoverInput,
    config: Option<&Path>,
) -> Result<BundleHost, HandoverReason> {
    use HandoverReason::{LanLiteral, ProxyCommand, ProxyJump, Unresolvable};

    let mut unresolved = false;
    let mut routes = Vec::new();
    for (route, alias) in [
        (BundleRoute::Lan, &remote.lan),
        (BundleRoute::Tailscale, &remote.tailscale),
    ] {
        if let Some(alias) = alias {
            match ResolvedRoute::read(route, alias, config).map(ResolvedRoute::tailnet_as_tailscale)
            {
                Ok(route) => routes.push(route),
                Err(error) => {
                    unresolved = true;
                    tracing::debug!(%alias, %error, "resolving handover route");
                }
            }
        }
    }
    if routes.iter().any(|route| route.alias.proxy_jump.is_some()) {
        return Err(ProxyJump);
    }
    if routes
        .iter()
        .any(|route| route.alias.proxy_command.is_some())
    {
        return Err(ProxyCommand);
    }
    if !routes
        .iter()
        .any(|route| route.route == BundleRoute::Tailscale)
        && routes
            .iter()
            .any(|route| is_lan_literal(&route.alias.hostname))
    {
        return Err(LanLiteral);
    }
    let primary = routes.first().ok_or(Unresolvable)?;
    let host_keys = route_keys(&routes)?;
    if unresolved
        || routes.iter().any(|route| {
            route.alias.user != primary.alias.user || route.alias.port != primary.alias.port
        })
    {
        return Err(Unresolvable);
    }
    Ok(BundleHost {
        host_id: remote.host_id,
        name: remote.name.clone(),
        os: remote.os.clone(),
        user: primary.alias.user.clone(),
        port: (primary.alias.port != 22).then_some(primary.alias.port),
        targets: bundle_targets(routes),
        host_keys,
    })
}

struct ResolvedRoute {
    route: BundleRoute,
    alias: ResolvedAlias,
    key_alias: Option<String>,
    key_files: Vec<PathBuf>,
    revocations: Option<PathBuf>,
}

impl ResolvedRoute {
    fn tailnet_as_tailscale(mut self) -> Self {
        if literal(&self.alias.hostname).is_some_and(|(ip, _)| is_tailnet(ip)) {
            self.route = BundleRoute::Tailscale;
        }
        self
    }

    fn read(route: BundleRoute, name: &str, config: Option<&Path>) -> Result<Self, SshConfigError> {
        let output = ssh_g(name, config)?;
        let fields = config_fields(&output);
        let alias = alias_fields(&fields)?;
        let home = EffectiveUser::lookup()?.home;
        let key_files = key_files(&fields, &home);
        let revocations = fields
            .get("revokedhostkeys")
            .filter(|&&path| path != "none")
            .map(|path| expand_home(path, &home));
        Ok(Self {
            route,
            alias,
            key_alias: fields.get("hostkeyalias").map(|name| (*name).to_owned()),
            key_files,
            revocations,
        })
    }
}

fn keys_for_host(
    host: &str,
    port: u16,
    key_alias: Option<&str>,
    files: &[PathBuf],
) -> Result<HostKeys, SshConfigError> {
    if let Some(key_alias) = key_alias {
        return search(key_alias, files);
    }
    let bare = search(host, files)?;
    if port == 22 {
        return Ok(bare);
    }
    Ok(search(&format!("[{host}]:{port}"), files)?.with_bare_host(bare))
}

fn key_files(fields: &BTreeMap<&str, &str>, home: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for key in ["userknownhostsfile", "globalknownhostsfile"] {
        if let Some(value) = fields.get(key) {
            // OpenSSH prints this list without quoting. A space in an absolute
            // pathname is distinguishable until the next absolute or ~/ path.
            for part in key_file_words(value) {
                let path = expand_home(part, home);
                if part == "none" {
                    continue;
                }
                if path.is_file() {
                    files.push(path);
                } else {
                    // The following path can be relative, which the config dump
                    // does not distinguish from spaces inside the preceding path.
                    files.extend(
                        part.split_ascii_whitespace()
                            .map(|path| expand_home(path, home)),
                    );
                }
            }
        }
    }
    files
}

fn expand_home(path: &str, home: &Path) -> PathBuf {
    path.strip_prefix("~/")
        .map_or_else(|| path.into(), |path| home.join(path))
}

fn key_file_words(value: &str) -> impl Iterator<Item = &str> {
    let has_absolute_paths = value.starts_with(['/', '~']);
    let mut rest = value.trim();
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let end = if has_absolute_paths {
            rest.match_indices(' ')
                .find(|&(offset, _)| rest[offset + 1..].starts_with(['/', '~']))
                .map_or(rest.len(), |(offset, _)| offset)
        } else {
            rest.find(char::is_whitespace).unwrap_or(rest.len())
        };
        let (head, tail) = rest.split_at(end);
        rest = tail.trim_start();
        Some(head)
    })
}

fn default_key_files(home: &Path) -> Vec<PathBuf> {
    [
        home.join(".ssh/known_hosts"),
        home.join(".ssh/known_hosts2"),
        "/etc/ssh/ssh_known_hosts".into(),
        "/etc/ssh/ssh_known_hosts2".into(),
    ]
    .into()
}

fn route_keys(routes: &[ResolvedRoute]) -> Result<Vec<BundleHostKey>, HandoverReason> {
    let keys = collect_route_keys(routes).map_err(|error| {
        tracing::warn!(%error, "reading handover host keys");
        if matches!(&error, SshConfigError::Io(error) if error.kind() == std::io::ErrorKind::TimedOut) {
            HandoverReason::Unresolvable
        } else {
            HandoverReason::NoHostKey
        }
    })?.trusted();
    if keys.is_empty() {
        Err(HandoverReason::NoHostKey)
    } else {
        Ok(keys)
    }
}

fn collect_route_keys(routes: &[ResolvedRoute]) -> Result<HostKeys, SshConfigError> {
    let mut keys = HostKeys::default();
    for route in routes {
        keys.extend(keys_for_host(
            &route.alias.hostname,
            route.alias.port,
            route.key_alias.as_deref(),
            &route.key_files,
        )?);
    }
    for path in routes
        .iter()
        .filter_map(|route| route.revocations.as_deref())
    {
        keys.apply_revocation_file(path)?;
    }
    Ok(keys)
}

/// A `HostName` that is an IP literal, without its `%zone` and with an IPv4-mapped IPv6
/// address as its IPv4 address, plus the zone.
fn literal(host: &str) -> Option<(IpAddr, Option<&str>)> {
    let (address, zone) = host
        .split_once('%')
        .map_or((host, None), |(address, zone)| (address, Some(zone)));
    Some((address.parse::<IpAddr>().ok()?.to_canonical(), zone))
}

fn is_lan_literal(host: &str) -> bool {
    match literal(host) {
        Some((IpAddr::V4(ip), _)) => ip.is_private() || ip.is_link_local(),
        Some((IpAddr::V6(ip), _)) => ip.is_unicast_link_local() || ip.is_unique_local(),
        None => false,
    }
}

/// Whether an address is in Tailscale's blocks (100.64.0.0/10, fd7a:115c:a1e0::/48). Such a
/// peer is reached over Tailscale, so it hands over as a Tailscale route whichever alias slot
/// it came from and is never a LAN literal (D-160).
fn is_tailnet(ip: IpAddr) -> bool {
    classify_address(ip) == AddressClass::Tailscale
}

/// Whether two `HostName`s name the same target: equal addresses for literals, or the same
/// name ignoring ASCII case.
fn same_host(a: &str, b: &str) -> bool {
    match (literal(a), literal(b)) {
        (Some(a), Some(b)) => a == b,
        (None, None) => a.eq_ignore_ascii_case(b),
        _ => false,
    }
}

/// Bundle targets in route order, one per host. A host both aliases reach keeps the first
/// spelling and is labelled Tailscale if either route is, so dialing it is never doubled and
/// a Tailscale route is never relabelled LAN.
fn bundle_targets(routes: Vec<ResolvedRoute>) -> Vec<BundleTarget> {
    let mut targets: Vec<BundleTarget> = Vec::new();
    for route in routes {
        match targets
            .iter_mut()
            .find(|target| same_host(&target.host, &route.alias.hostname))
        {
            Some(target) if route.route == BundleRoute::Tailscale => {
                target.route = BundleRoute::Tailscale;
            }
            Some(_) => {}
            None => targets.push(BundleTarget {
                route: route.route,
                host: route.alias.hostname,
            }),
        }
    }
    targets
}

pub struct HandoverInput {
    pub host_id: HostId,
    pub name: String,
    pub os: String,
    pub lan: Option<String>,
    pub tailscale: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum SshConfigError {
    #[error("ssh -G: {0}")]
    Resolve(String),
    #[error("ssh-keygen: {0}")]
    Keys(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
