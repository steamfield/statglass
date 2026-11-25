//! OpenSSH configuration and host keys for handover.

use std::path::Path;

use statglass_proto::{
    handover::HandoverReason,
    pairing::{BundleHost, BundleHostKey},
};
use statglass_schema::HostId;

pub struct ResolvedAlias {
    pub hostname: String,
    pub user: String,
    pub port: u16,
    pub proxy_jump: Option<String>,
    pub proxy_command: Option<String>,
}

pub fn parse_ssh_g(_output: &str) -> Result<ResolvedAlias, SshConfigError> {
    Err(SshConfigError::Resolve("not implemented".into()))
}

pub fn resolve(_alias: &str, _config: Option<&Path>) -> Result<ResolvedAlias, SshConfigError> {
    Err(SshConfigError::Resolve("not implemented".into()))
}

pub fn known_host_keys(
    _host: &str,
    _port: u16,
    _known_hosts: Option<&Path>,
) -> Result<Vec<BundleHostKey>, SshConfigError> {
    Err(SshConfigError::Keys("not implemented".into()))
}

pub fn handover_host(
    _remote: &HandoverInput,
    _config: Option<&Path>,
) -> Result<BundleHost, HandoverReason> {
    Err(HandoverReason::Unresolvable)
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
