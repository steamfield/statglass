//! Where a session dials: a host's targets in preference order, plus the port, user,
//! pinned host keys and remote command every target shares.
use crate::{RemoteCommand, RemoteError, Result};
use serde::{Deserialize, Serialize};
use std::fmt;

/// The network a target is reached over. `Ord` is preference: LAN before Tailscale.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    Lan,
    Tailscale,
}

impl fmt::Display for Route {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Lan => "LAN",
            Self::Tailscale => "Tailscale",
        })
    }
}

/// One way to reach a host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub route: Route,
    /// An SSH config alias, a DNS name or an address literal.
    pub host: String,
}

/// A host key the phone accepts for a host, from pairing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedHostKey {
    /// The SSH key algorithm, such as `"ssh-ed25519"`.
    pub algorithm: String,
    /// The OpenSSH fingerprint, `"SHA256:"` followed by unpadded base64.
    pub sha256: String,
}

/// The most targets one endpoint carries (LAN, MagicDNS, the 100.x address and a spare).
pub const MAX_TARGETS: usize = 4;

/// Everything a [`Dialer`](crate::Dialer) needs to reach one host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    /// In preference order.
    pub targets: Vec<Target>,
    /// `None` uses the dialer's default (the OpenSSH config, or 22).
    pub port: Option<u16>,
    /// `None` uses the OpenSSH config; the russh dialer requires one.
    pub user: Option<String>,
    /// The keys the russh dialer accepts. OpenSSH ignores them and checks known_hosts.
    pub host_keys: Vec<PinnedHostKey>,
    pub command: RemoteCommand,
}

impl Endpoint {
    /// Rejects an endpoint no dialer should try: no targets or more than
    /// [`MAX_TARGETS`], a host or user that could read as an option, or port 0.
    pub fn validate(&self) -> Result<()> {
        if self.targets.is_empty() || self.targets.len() > MAX_TARGETS {
            return Err(RemoteError::Protocol(format!(
                "an endpoint needs 1 to {MAX_TARGETS} targets, got {}",
                self.targets.len()
            )));
        }
        for target in &self.targets {
            if !is_ssh_word(&target.host) {
                return Err(RemoteError::Protocol(format!(
                    "invalid SSH host {:?}",
                    target.host
                )));
            }
        }
        if self.port == Some(0) {
            return Err(RemoteError::Protocol("SSH port 0 is not valid".into()));
        }
        if let Some(user) = &self.user
            && !is_ssh_word(user)
        {
            return Err(RemoteError::Protocol(format!("invalid SSH user {user:?}")));
        }
        Ok(())
    }

    /// The route of the only target, or `None` when there are several (or none).
    pub fn single_route(&self) -> Option<Route> {
        match self.targets.as_slice() {
            [only] => Some(only.route),
            _ => None,
        }
    }

    /// This endpoint narrowed to the targets whose route is preferred over `route`, or
    /// `None` when there are none.
    pub fn better_than(&self, route: Route) -> Option<Endpoint> {
        let targets: Vec<Target> = self
            .targets
            .iter()
            .filter(|target| target.route < route)
            .cloned()
            .collect();
        (!targets.is_empty()).then(|| Endpoint {
            targets,
            ..self.clone()
        })
    }
}

/// A non-empty word that no SSH client reads as an option or splits.
fn is_ssh_word(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value.len() <= 255
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(route: Route, host: &str) -> Target {
        Target {
            route,
            host: host.into(),
        }
    }

    fn endpoint(targets: Vec<Target>) -> Endpoint {
        Endpoint {
            targets,
            port: None,
            user: None,
            host_keys: Vec::new(),
            command: RemoteCommand::default(),
        }
    }

    #[test]
    fn rejects_endpoints_no_dialer_should_try() {
        let one = endpoint(vec![target(Route::Lan, "studio.local")]);
        assert!(one.validate().is_ok());
        let mut cases = vec![
            endpoint(Vec::new()),
            endpoint(vec![target(Route::Lan, "a"); MAX_TARGETS + 1]),
            endpoint(vec![target(Route::Lan, "")]),
            endpoint(vec![target(Route::Lan, "-oProxyCommand=x")]),
            endpoint(vec![target(Route::Lan, "a b")]),
        ];
        for (port, user) in [
            (Some(0), None),
            (None, Some("me you")),
            (None, Some("-l")),
            (None, Some("")),
        ] {
            let mut case = one.clone();
            case.port = port;
            case.user = user.map(str::to_string);
            cases.push(case);
        }
        for case in cases {
            assert!(
                matches!(case.validate(), Err(RemoteError::Protocol(_))),
                "{case:?}"
            );
        }
        let mut full = endpoint(vec![target(Route::Tailscale, "100.64.0.1"); MAX_TARGETS]);
        full.port = Some(2222);
        full.user = Some("statglass".into());
        assert!(full.validate().is_ok());
    }

    #[test]
    fn promotion_narrows_to_strictly_better_routes() {
        let all = endpoint(vec![
            target(Route::Lan, "studio.local"),
            target(Route::Tailscale, "studio.tail1.ts.net"),
            target(Route::Tailscale, "100.64.0.1"),
        ]);
        assert_eq!(all.single_route(), None);
        let better = all.better_than(Route::Tailscale).unwrap();
        assert_eq!(better.targets, vec![target(Route::Lan, "studio.local")]);
        assert_eq!(better.single_route(), Some(Route::Lan));
        assert_eq!(all.better_than(Route::Lan), None);
        let tailnet = endpoint(all.targets[1..].to_vec());
        assert_eq!(tailnet.better_than(Route::Tailscale), None);
    }

    #[test]
    fn routes_read_as_the_settings_name_them() {
        assert_eq!(Route::Lan.to_string(), "LAN");
        assert_eq!(Route::Tailscale.to_string(), "Tailscale");
        assert!(Route::Lan < Route::Tailscale);
    }
}
