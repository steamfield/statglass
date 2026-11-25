use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

use statglass_proto::pairing::BundleHostKey;

use super::{SshConfigError, process};

#[derive(Default)]
pub(super) struct HostKeys {
    pinned: BTreeMap<(String, String), String>,
    revoked: BTreeSet<String>,
}

impl HostKeys {
    pub(super) fn extend(&mut self, other: Self) {
        self.pinned.extend(other.pinned);
        self.revoked.extend(other.revoked);
    }

    pub(super) fn trusted(self) -> Vec<BundleHostKey> {
        self.pinned
            .into_keys()
            .filter(|(_, sha256)| !self.revoked.contains(sha256))
            .map(|(algorithm, sha256)| BundleHostKey { algorithm, sha256 })
            .collect()
    }

    pub(super) fn with_bare_host(mut self, mut bare: Self) -> Self {
        // OpenSSH applies a bare-host revocation on every port. It falls back
        // to bare-host pins when the port-specific host has no pinned keys.
        if !self.pinned.is_empty() {
            bare.pinned.clear();
        }
        self.extend(bare);
        self
    }

    pub(super) fn apply_revocation_file(&mut self, path: &Path) -> Result<(), SshConfigError> {
        if !fs::metadata(path)?.is_file() {
            return Err(SshConfigError::Keys(
                "revocation list is not a regular file".into(),
            ));
        }
        let bytes = fs::read(path)?;
        if bytes.starts_with(b"SSHKRL\n\0") {
            for ((algorithm, fingerprint), encoded) in &self.pinned {
                if is_in_krl(path, algorithm, encoded)? {
                    self.revoked.insert(fingerprint.clone());
                }
            }
        } else {
            let text = String::from_utf8_lossy(&bytes);
            let keys: BTreeSet<&str> = text
                .lines()
                .filter_map(|line| {
                    let mut fields = line.split_ascii_whitespace();
                    let algorithm = fields.next()?;
                    (!algorithm.starts_with('#')).then_some(())?;
                    fields.next().map(|key| key.trim_end_matches('='))
                })
                .collect();
            for ((_, fingerprint), key) in &self.pinned {
                if keys.contains(key.trim_end_matches('=')) {
                    self.revoked.insert(fingerprint.clone());
                }
            }
        }
        Ok(())
    }
}

fn is_in_krl(path: &Path, algorithm: &str, encoded: &str) -> Result<bool, SshConfigError> {
    let mut command = Command::new("/usr/bin/ssh-keygen");
    command.args(["-Q", "-q", "-f"]).arg(path).arg("/dev/stdin");
    let result = process::output(
        command,
        Some(format!("{algorithm} {encoded}\n").into_bytes()),
    )?;
    match result.status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(SshConfigError::Keys(format!(
            "{}: {}",
            path.display(),
            String::from_utf8_lossy(&result.stderr).trim()
        ))),
    }
}

pub(super) fn search(lookup: &str, files: &[PathBuf]) -> Result<HostKeys, SshConfigError> {
    let mut keys = HostKeys::default();
    for path in files {
        match fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => continue, // Includes /dev/null, often set to disable a source.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        }
        let mut command = Command::new("/usr/bin/ssh-keygen");
        command.args(["-F", lookup, "-f"]).arg(path);
        let result = process::output(command, None)?;
        if !result.status.success() {
            if result.status.code() == Some(1) && result.stderr.is_empty() {
                continue;
            }
            return Err(SshConfigError::Keys(format!(
                "{}: {}",
                path.display(),
                String::from_utf8_lossy(&result.stderr).trim()
            )));
        }
        let output = String::from_utf8(result.stdout)
            .map_err(|error| SshConfigError::Keys(error.to_string()))?;
        for line in output.lines() {
            add_entry(line, &mut keys)?;
        }
    }
    Ok(keys)
}

fn add_entry(line: &str, keys: &mut HostKeys) -> Result<(), SshConfigError> {
    let mut fields = line.split_ascii_whitespace();
    let Some(first) = fields.next() else {
        return Ok(());
    };
    if first.starts_with('#') {
        return Ok(());
    }
    let revoked = match first {
        "@revoked" => {
            fields.next(); // host patterns
            true
        }
        marker if marker.starts_with('@') => return Ok(()), // CA entries do not pin a host key
        _ => false,
    };
    let (Some(algorithm), Some(encoded)) = (fields.next(), fields.next()) else {
        return Err(SshConfigError::Keys("incomplete known_hosts entry".into()));
    };
    let sha256 = fingerprint(algorithm, encoded)?;
    if revoked {
        keys.revoked.insert(sha256);
    } else {
        keys.pinned
            .insert((algorithm.into(), sha256), encoded.into());
    }
    Ok(())
}

fn fingerprint(algorithm: &str, encoded: &str) -> Result<String, SshConfigError> {
    let mut command = Command::new("/usr/bin/ssh-keygen");
    command.args(["-lf", "-", "-E", "sha256"]);
    let result = process::output(
        command,
        Some(format!("{algorithm} {encoded}\n").into_bytes()),
    )?;
    if !result.status.success() {
        return Err(SshConfigError::Keys(
            String::from_utf8_lossy(&result.stderr).trim().into(),
        ));
    }
    String::from_utf8_lossy(&result.stdout)
        .split_ascii_whitespace()
        .nth(1)
        .filter(|key| key.starts_with("SHA256:"))
        .map(str::to_owned)
        .ok_or_else(|| SshConfigError::Keys("missing SHA-256 fingerprint".into()))
}
