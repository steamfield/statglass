use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use statglass_engine::wall_ms;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::MobileHost;
use tempfile::NamedTempFile;

use crate::sessions::validate_hosts;

#[derive(Clone)]
pub(crate) struct HostStore {
    path: PathBuf,
    device_key: OnceLock<String>,
    read_failure: OnceLock<String>,
}

#[derive(Deserialize, Serialize)]
struct HostFile<Hosts> {
    device_key: Option<String>,
    hosts: Hosts,
}

impl HostStore {
    pub(crate) fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("hosts.json"),
            device_key: OnceLock::new(),
            read_failure: OnceLock::new(),
        }
    }

    pub(crate) fn load(&self) -> Vec<MobileHost> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Vec::new(),
            Err(error) => {
                tracing::warn!(%error, path = %self.path.display(), "reading paired hosts");
                self.read_failure.get_or_init(|| error.to_string());
                return Vec::new();
            }
        };
        match decode(&bytes) {
            Ok(file) => {
                if let Some(key) = file.device_key {
                    self.device_key.get_or_init(|| key);
                }
                file.hosts
            }
            Err(error) => {
                let corrupt = self
                    .path
                    .with_extension(format!("json.corrupt-{}", wall_ms()));
                match fs::rename(&self.path, &corrupt) {
                    Ok(()) => {
                        tracing::warn!(%error, path = %corrupt.display(), "moved aside corrupt paired hosts")
                    }
                    Err(rename_error) => {
                        tracing::warn!(%error, %rename_error, path = %self.path.display(), "could not move aside corrupt paired hosts");
                        self.read_failure.get_or_init(|| {
                            format!("moving aside corrupt paired hosts: {rename_error}")
                        });
                    }
                }
                Vec::new()
            }
        }
    }

    pub(crate) fn save(&self, hosts: &[MobileHost]) -> Result<(), CommandError> {
        if let Some(error) = self.read_failure.get() {
            return Err(CommandError::Store {
                message: format!(
                    "recover {} before saving paired hosts: {error}",
                    self.path.display()
                ),
            });
        }
        self.write(hosts).map_err(|error| CommandError::Store {
            message: format!("saving paired hosts to {}: {error}", self.path.display()),
        })
    }

    pub(crate) fn with_device_key(mut self, device_key: &[u8]) -> Self {
        self.device_key = OnceLock::from(STANDARD.encode(device_key));
        self
    }

    pub(crate) fn has_device_key(&self) -> bool {
        self.device_key.get().is_some()
    }

    pub(crate) fn key_changed(&self, device_key: &[u8]) -> bool {
        self.device_key
            .get()
            .is_some_and(|saved| *saved != STANDARD.encode(device_key))
    }

    fn write(&self, hosts: &[MobileHost]) -> io::Result<()> {
        let dir = self
            .path
            .parent()
            .ok_or_else(|| io::Error::other("missing host store directory"))?;
        let mut temp = NamedTempFile::new_in(dir)?;
        serde_json::to_writer(
            temp.as_file_mut(),
            &HostFile {
                device_key: self.device_key.get().cloned(),
                hosts,
            },
        )?;
        temp.as_file().sync_all()?;
        temp.persist(&self.path)?;
        Ok(())
    }
}

fn decode(bytes: &[u8]) -> io::Result<HostFile<Vec<MobileHost>>> {
    let file: HostFile<Vec<MobileHost>> = serde_json::from_slice(bytes)?;
    validate_hosts(&file.hosts).map_err(|error| io::Error::new(ErrorKind::InvalidData, error))?;
    if let Some(key) = &file.device_key
        && !matches!(STANDARD.decode(key).as_deref(), Ok([4, coordinates @ ..]) if coordinates.len() == 64)
    {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "invalid base64 SEC1 device key",
        ));
    }
    Ok(file)
}
