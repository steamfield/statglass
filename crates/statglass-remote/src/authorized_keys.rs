//! The file-backed [`DeviceKeys`]: StatGlass's edits to `~/.ssh/authorized_keys` (RFC
//! `plan/rfc-ios-app.md` 2.5). Only `statglass-mobile:` and `statglass-pairing:` lines
//! are added or removed; every other line is kept byte for byte.
//! Pairing expiries use the host's /etc/localtime zone through seconds, the format sshd reads
//! starting with OpenSSH 7.7. The pairing protocol also checks its UTC deadline.
mod expiry;
mod line;

use line::{entries, entry, without_token};

use crate::device_keys::{DeviceKeys, DeviceKeysError, DeviceTag, EcdsaP256Public, PairedDevice};
use sha2::{Digest, Sha256};
use statglass_proto::pairing::valid_nonce;
use std::{
    borrow::Cow,
    fs::{self, DirBuilder, File, OpenOptions, Permissions},
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const KEY_TYPE: &str = "ecdsa-sha2-nistp256";
const DEVICE: &str = "statglass-mobile:";
const PAIRING: &str = "statglass-pairing:";
const KEY_HEADER: &[u8] = b"\0\0\0\x13ecdsa-sha2-nistp256\0\0\0\x08nistp256\0\0\0\x41";

impl EcdsaP256Public {
    /// The uncompressed public key as padded base64 SEC1.
    pub fn to_base64(&self) -> String {
        encode_base64(&self.0)
    }

    /// Decodes the SEC1 public key passed to the one-shot authorization commands.
    pub fn from_base64(text: &str) -> Result<Self, DeviceKeysError> {
        let key = matches!(text.len(), 87 | 88)
            .then(|| decode_base64(text.as_bytes()))
            .flatten()
            .and_then(|point| <[u8; 65]>::try_from(point).ok())
            .filter(|point| valid_key(point))
            .map(Self);
        key.ok_or_else(|| {
            DeviceKeysError::Invalid("expected a base64 uncompressed P-256 public key".into())
        })
    }

    /// Decodes the public key line the phone displays, ignoring its optional comment.
    pub fn from_authorized_key(line: &str) -> Result<Self, DeviceKeysError> {
        let mut fields = line.split_ascii_whitespace();
        if !line.contains(['\r', '\n'])
            && fields.next() == Some(KEY_TYPE)
            && let Some(blob) = fields.next().and_then(|key| decoded_blob(key.as_bytes()))
            && let Some(Ok(point)) = blob.strip_prefix(KEY_HEADER).map(<[u8; 65]>::try_from)
        {
            return Ok(Self(point));
        }
        Err(DeviceKeysError::Invalid(
            "expected one ecdsa-sha2-nistp256 public key line".into(),
        ))
    }
}

/// One `authorized_keys` file, symlinks followed.
pub struct AuthorizedKeys {
    path: PathBuf,
}

impl AuthorizedKeys {
    /// `~/.ssh/authorized_keys` of the user running this process.
    pub fn for_current_user() -> Result<Self, DeviceKeysError> {
        let user = crate::effective_user::EffectiveUser::lookup()?;
        Ok(Self::at(user.home.join(".ssh/authorized_keys")))
    }

    /// The file at `path`.
    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }

    /// The enrolled device keys and names to provision when a controller adds a host.
    pub fn list_device_keys(
        &self,
    ) -> Result<Vec<(DeviceTag, String, EcdsaP256Public)>, DeviceKeysError> {
        self.read_devices(|tag, name, blob| {
            let key = EcdsaP256Public(blob.strip_prefix(KEY_HEADER)?.try_into().ok()?);
            (DeviceTag::from_key(&key) == tag).then_some((tag, name, key))
        })
    }

    fn read_devices<T>(
        &self,
        mut view: impl FnMut(DeviceTag, String, Vec<u8>) -> Option<T>,
    ) -> Result<Vec<T>, DeviceKeysError> {
        let Some(file) = key_io(
            read_keys(&self.path, libc::O_NONBLOCK),
            "reading",
            &self.path,
        )?
        else {
            return Ok(Vec::new());
        };
        Ok(entries(&file.bytes)
            .filter_map(|entry| {
                let tag = DeviceTag::parse(
                    std::str::from_utf8(entry.token.strip_prefix(DEVICE.as_bytes())?).ok()?,
                )?;
                let blob = decoded_blob(entry.key)?;
                let name = sanitize_name(&String::from_utf8_lossy(entry.name));
                view(tag, name, blob)
            })
            .collect())
    }

    fn install(
        &self,
        token: &str,
        line: String,
        key: &str,
        expiry: Option<&expiry::PairingExpiry>,
    ) -> Result<(), DeviceKeysError> {
        let key = key.trim_end_matches('=').as_bytes();
        self.edit(true, |current| {
            let current = expiry.map_or(Cow::Borrowed(current), |expiry| {
                Cow::Owned(expiry.prune(current))
            });
            for entry in entries(&current) {
                let same_key = entry.key.strip_suffix(b"=").unwrap_or(entry.key) == key;
                if same_key && entry.token != token.as_bytes() {
                    return Err(DeviceKeysError::Invalid(
                        "key is already authorized by another line".into(),
                    ));
                }
                if !same_key && entry.token == token.as_bytes() && decoded_blob(entry.key).is_some()
                {
                    return Err(DeviceKeysError::Invalid(format!(
                        "another key already uses {token}"
                    )));
                }
            }
            let mut matching = current
                .split_inclusive(|&byte| byte == b'\n')
                .filter(|line| entry(line).is_some_and(|entry| entry.token == token.as_bytes()));
            if matching.next().is_some_and(|existing| {
                existing.trim_ascii_end() == line.trim_ascii_end().as_bytes()
            }) && matching.next().is_none()
            {
                return Ok(Some(current.to_vec()));
            }
            let mut next = without_token(&current, token);
            // Place the entry before an unterminated final line to keep its bytes intact.
            let end = next
                .iter()
                .rposition(|&byte| byte == b'\n')
                .map_or(0, |i| i + 1);
            next.splice(end..end, line.bytes());
            Ok(Some(next))
        })?;
        Ok(())
    }

    fn remove(&self, token: &str) -> Result<bool, DeviceKeysError> {
        self.edit(false, |current| {
            let next = without_token(current, token);
            Ok((next.len() != current.len()).then_some(next))
        })
    }

    fn edit(
        &self,
        create: bool,
        change: impl FnMut(&[u8]) -> Result<Option<Vec<u8>>, DeviceKeysError>,
    ) -> Result<bool, DeviceKeysError> {
        let directory = parent(&self.path);
        if create {
            key_io(
                DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(directory),
                "creating",
                directory,
            )?;
        } else if !key_io(directory.try_exists(), "looking for", directory)? {
            return Ok(false);
        }
        let target = key_io(resolve_target(&self.path), "resolving", &self.path)?;
        if directory.file_name().is_some_and(|name| name == ".ssh") {
            key_io(
                fs::set_permissions(directory, Permissions::from_mode(0o700)),
                "securing",
                directory,
            )?;
        }
        let lock_path = parent(&target).join(".statglass.lock");
        let open_lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&lock_path);
        let lock = key_io(open_lock, "opening", &lock_path)?;
        key_io(
            require_regular(&lock).and_then(|()| lock.lock()),
            "locking",
            &lock_path,
        )?;
        merge_and_replace(&self.path, &target, change)
    }
}

impl DeviceKeys for AuthorizedKeys {
    fn list_devices(&self) -> Result<Vec<PairedDevice>, DeviceKeysError> {
        self.read_devices(|tag, name, blob| {
            let digest = encode_base64(&Sha256::digest(blob));
            Some(PairedDevice {
                tag,
                name,
                fingerprint: format!("SHA256:{}", digest.trim_end_matches('=')),
            })
        })
    }

    fn add_device(
        &self,
        key: &EcdsaP256Public,
        name: &str,
        command: &str,
    ) -> Result<DeviceTag, DeviceKeysError> {
        let key_text = encode_key(key)?;
        let command = escape_option(command)?;
        let tag = DeviceTag::from_key(key);
        let token = format!("{DEVICE}{tag}");
        let comment = format!("{token} {}", sanitize_name(name));
        let line = format!(
            "restrict,command=\"{command}\" {KEY_TYPE} {key_text} {}\n",
            comment.trim_end()
        );
        self.install(&token, line, &key_text, None)?;
        Ok(tag)
    }

    fn revoke(&self, tag: DeviceTag) -> Result<bool, DeviceKeysError> {
        self.remove(&format!("{DEVICE}{tag}"))
    }

    fn add_pairing(
        &self,
        key: &EcdsaP256Public,
        nonce: &str,
        expires_ms: i64,
        command: &str,
    ) -> Result<(), DeviceKeysError> {
        let token = pairing_token(nonce)?;
        let key = encode_key(key)?;
        let command = escape_option(command)?;
        let expiry = expiry::PairingExpiry::new()?;
        let deadline = expiry.format(expires_ms)?;
        let line = format!(
            "restrict,expiry-time=\"{deadline}\",command=\"{command}\" {KEY_TYPE} {key} {token}\n"
        );
        self.install(&token, line, &key, Some(&expiry))
    }

    fn remove_pairing(&self, nonce: &str) -> Result<bool, DeviceKeysError> {
        self.remove(&pairing_token(nonce)?)
    }
}

fn pairing_token(nonce: &str) -> Result<String, DeviceKeysError> {
    if !valid_nonce(nonce) {
        return Err(DeviceKeysError::Invalid(
            "expected a 128-bit hex pairing nonce".into(),
        ));
    }
    Ok(format!("{PAIRING}{nonce}"))
}

fn sanitize_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || " ._-".contains(*c))
        .take(32)
        .collect()
}

// The caller supplies a shell command with the executable and any paths already quoted.
// OpenSSH's command option unescapes double quotes and copies other backslashes literally.
fn escape_option(command: &str) -> Result<String, DeviceKeysError> {
    if command.trim().is_empty() || command.chars().any(char::is_control) || command.ends_with('\\')
    {
        return Err(DeviceKeysError::Invalid("invalid forced command".into()));
    }
    Ok(command.replace('"', "\\\""))
}

fn encode_key(key: &EcdsaP256Public) -> Result<String, DeviceKeysError> {
    if !valid_key(&key.0) {
        return Err(DeviceKeysError::Invalid(
            "expected a valid uncompressed P-256 key".into(),
        ));
    }
    let blob = [KEY_HEADER, key.0.as_slice()].concat();
    Ok(encode_base64(&blob))
}

fn valid_key(point: &[u8]) -> bool {
    point.len() == 65
        && point.first() == Some(&4)
        && p256::PublicKey::from_sec1_bytes(point).is_ok()
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn encode_base64(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let [a, b, c] = std::array::from_fn(|i| chunk.get(i).copied().unwrap_or(0));
        let values = [
            a >> 2,
            ((a & 3) << 4) | (b >> 4),
            ((b & 15) << 2) | (c >> 6),
            c & 63,
        ];
        result.extend(
            values
                .iter()
                .take(chunk.len() + 1)
                .map(|&value| char::from(BASE64[usize::from(value)])),
        );
        result.extend(std::iter::repeat_n('=', 3 - chunk.len()));
    }
    result
}

fn decoded_blob(text: &[u8]) -> Option<Vec<u8>> {
    let blob = decode_base64(text)?;
    valid_key(blob.strip_prefix(KEY_HEADER)?).then_some(blob)
}

fn decode_base64(text: &[u8]) -> Option<Vec<u8>> {
    let mut bits = 0;
    let mut value = 0u16;
    let mut blob = Vec::new();
    let unpadded = text
        .strip_suffix(b"==")
        .or_else(|| text.strip_suffix(b"="))
        .unwrap_or(text);
    for byte in unpadded {
        let digit = BASE64.iter().position(|entry| entry == byte)? as u16;
        value = (value << 6) | digit;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            blob.push((value >> bits) as u8);
        }
    }
    let canonical = encode_base64(&blob);
    (canonical.as_bytes() == text || canonical.trim_end_matches('=').as_bytes() == text)
        .then_some(blob)
}

fn parent(path: &Path) -> &Path {
    path.parent()
        .filter(|part| !part.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn resolve_target(path: &Path) -> io::Result<PathBuf> {
    let mut path = path.to_path_buf();
    // Canonicalize the directory and follow the final links even if the target is
    // missing. Each alias then uses the same lock and rename directory.
    for _ in 0..40 {
        let name = path.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "authorized_keys needs a file name",
            )
        })?;
        let directory = fs::canonicalize(parent(&path))?;
        path = directory.join(name);
        match fs::read_link(&path) {
            Ok(target) => path = directory.join(target),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::InvalidInput | io::ErrorKind::NotFound
                ) =>
            {
                return Ok(path);
            }
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "too many authorized_keys symlinks",
    ))
}

#[derive(PartialEq)]
struct KeysFile {
    bytes: Vec<u8>,
    mode: u32,
}

fn require_regular(file: &File) -> io::Result<()> {
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a regular file",
        ));
    }
    Ok(())
}

fn read_keys(path: &Path, flags: i32) -> io::Result<Option<KeysFile>> {
    let mut file = match OpenOptions::new().read(true).custom_flags(flags).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    require_regular(&file)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(KeysFile {
        bytes,
        mode: file.metadata()?.permissions().mode() & 0o7777,
    }))
}

fn merge_and_replace(
    path: &Path,
    target: &Path,
    mut change: impl FnMut(&[u8]) -> Result<Option<Vec<u8>>, DeviceKeysError>,
) -> Result<bool, DeviceKeysError> {
    let read = || {
        key_io(
            read_keys(target, libc::O_NOFOLLOW | libc::O_NONBLOCK),
            "reading",
            target,
        )
    };
    let mut current = read()?;
    for _ in 0..4 {
        let Some(bytes) = change(current.as_ref().map_or(&[], |file| file.bytes.as_slice()))?
        else {
            return Ok(false);
        };
        let next = KeysFile { bytes, mode: 0o600 };
        if current.as_ref() == Some(&next) {
            return Ok(false);
        }
        let temp = parent(target).join(format!(".statglass-{}.tmp", Uuid::new_v4()));
        let staged = key_io(
            StagedFile::create(temp.clone(), &next.bytes),
            "staging",
            &temp,
        )?;
        if key_io(resolve_target(path), "resolving", path)? != target {
            return Err(DeviceKeysError::Invalid(format!(
                "{} changed targets during the edit",
                path.display()
            )));
        }
        // A writer that ignores our lock may have changed the file while we staged
        // and flushed the edit. Merge against the latest bytes before renaming.
        let latest = read()?;
        if latest == current {
            key_io(fs::rename(&staged.0, target), "replacing", target)?;
            return Ok(true);
        }
        current = latest;
    }
    key_io(
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "authorized_keys kept changing during edit",
        )),
        "replacing",
        target,
    )
}

#[derive(Debug, thiserror::Error)]
#[error("{operation} {}", path.display())]
struct KeyFileIo {
    operation: &'static str,
    path: PathBuf,
    #[source]
    source: io::Error,
}

fn key_io<T>(
    result: io::Result<T>,
    operation: &'static str,
    path: &Path,
) -> Result<T, DeviceKeysError> {
    result.map_err(|source| {
        io::Error::new(
            source.kind(),
            KeyFileIo {
                operation,
                path: path.to_path_buf(),
                source,
            },
        )
        .into()
    })
}

#[derive(Debug)]
struct StagedFile(PathBuf);

impl StagedFile {
    fn create(path: PathBuf, bytes: &[u8]) -> io::Result<Self> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        let staged = Self(path);
        file.set_permissions(Permissions::from_mode(0o600))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(staged)
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.0)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(path = %self.0.display(), error = &error as &dyn std::error::Error, "removing staged authorized_keys");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_sec1_key_for_an_enrolled_device() {
        use p256::elliptic_curve::sec1::ToSec1Point;

        let dir = tempfile::tempdir().unwrap();
        let keys = AuthorizedKeys::at(dir.path().join("authorized_keys"));
        let secret = p256::SecretKey::from_slice(&[1; 32]).unwrap();
        let point = secret.public_key().to_sec1_point(false);
        let key = EcdsaP256Public(point.as_bytes().try_into().unwrap());
        keys.add_pairing(&key, &"a".repeat(32), 2_000_000_000_000, "/helper pair")
            .unwrap();
        assert!(keys.list_device_keys().unwrap().is_empty());
        keys.remove_pairing(&"a".repeat(32)).unwrap();
        let tag = keys
            .add_device(&key, "Travel iPhone", "/helper restricted")
            .unwrap();
        assert_eq!(
            keys.list_device_keys().unwrap(),
            [(tag, "Travel iPhone".into(), key)]
        );
    }

    #[test]
    fn current_users_authorized_keys_uses_the_passwd_home() {
        const EXPECTED_HOME: &str = "STATGLASS_TEST_AUTHORIZED_KEYS_HOME";
        if let Some(home) = std::env::var_os(EXPECTED_HOME) {
            let keys = AuthorizedKeys::for_current_user().unwrap();
            assert_eq!(keys.path, Path::new(&home).join(".ssh/authorized_keys"));
            return;
        }

        let user = crate::effective_user::EffectiveUser::lookup().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "authorized_keys::tests::current_users_authorized_keys_uses_the_passwd_home",
            ])
            .env("HOME", "/fake-authorized-keys-home")
            .env("USER", "fake-authorized-keys-user")
            .env(EXPECTED_HOME, user.home)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }

    #[test]
    fn merges_an_append_made_after_the_initial_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("authorized_keys");
        fs::write(&path, b"original\n").unwrap();
        let keys = AuthorizedKeys::at(path.clone());
        let mut appended = false;
        keys.edit(true, |current| {
            let mut next = current.to_vec();
            next.extend_from_slice(b"our line\n");
            if !appended {
                OpenOptions::new()
                    .append(true)
                    .open(&path)?
                    .write_all(b"other line\r\n")?;
                appended = true;
            }
            Ok(Some(next))
        })
        .unwrap();
        assert_eq!(
            fs::read(path).unwrap(),
            b"original\nother line\r\nour line\n"
        );
    }

    #[test]
    fn an_edit_does_not_commit_to_a_retargeted_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("authorized_keys");
        let original = dir.path().join("original");
        let replacement = dir.path().join("replacement");
        let redirected = dir.path().join("redirected");
        fs::write(&original, b"original\n").unwrap();
        fs::write(&replacement, b"replacement\n").unwrap();
        std::os::unix::fs::symlink(&original, &link).unwrap();
        std::os::unix::fs::symlink(&replacement, &redirected).unwrap();
        let keys = AuthorizedKeys::at(link.clone());
        let result = keys.edit(true, |_| {
            fs::rename(&redirected, &link)?;
            Ok(Some(b"our edit\n".to_vec()))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&original).unwrap(), b"original\n");
        assert_eq!(fs::read(&link).unwrap(), b"replacement\n");
    }

    #[test]
    fn an_existing_temporary_file_is_never_removed_by_a_failed_stage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing");
        fs::write(&path, b"other writer").unwrap();
        assert_eq!(
            StagedFile::create(path.clone(), b"ours")
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(path).unwrap(), b"other writer");
    }
}
