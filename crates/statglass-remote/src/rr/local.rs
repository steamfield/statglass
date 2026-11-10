//! Local counterpart of the controller's rr SSH observation, with no agent access.
use super::{LOCK_DIR, MAX_BYTES, RrJob, parse};
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

fn current_user() -> io::Result<String> {
    // SAFETY: zeroed passwd is initialized by getpwuid_r before its fields are read.
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result = std::ptr::null_mut();
    let mut buffer = vec![0u8; 16_384];
    // SAFETY: all output pointers are valid and buffer remains live through conversion.
    let code = unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            &mut pwd,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if code != 0 {
        return Err(io::Error::from_raw_os_error(code));
    }
    if result.is_null() {
        return Err(io::Error::other("current user has no passwd entry"));
    }
    // SAFETY: successful getpwuid_r supplied a terminated name within buffer.
    Ok(unsafe { std::ffi::CStr::from_ptr(pwd.pw_name) }
        .to_string_lossy()
        .into_owned())
}

fn bytes(dir: &Path) -> io::Result<Option<Vec<u8>>> {
    // SAFETY: geteuid has no preconditions. Compare against opened descriptors.
    let uid = unsafe { libc::geteuid() };
    read_owned(dir, |metadata| metadata.uid() == uid)
}

pub(super) fn read_owned(
    dir: &Path,
    owns: impl Fn(&std::fs::Metadata) -> bool,
) -> io::Result<Option<Vec<u8>>> {
    let metadata = std::fs::symlink_metadata(dir)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(None);
    }
    let metadata = std::fs::symlink_metadata(dir.join("info.json"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Ok(None);
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_DIRECTORY)
        .open(dir)?;
    if !owns(&directory.metadata()?) {
        return Ok(None);
    }
    // Pin the directory so replacing it with a symlink cannot redirect this open.
    // SAFETY: directory is live and the filename is a constant terminated string.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c"info.json".as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor; File takes ownership exactly once.
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file() || !owns(&metadata) {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES).read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

pub(super) fn read_at(dir: &Path, login: &str) -> Option<RrJob> {
    match bytes(dir) {
        Ok(Some(bytes)) => parse(&bytes, login),
        Ok(None) => None,
        Err(error) => {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::debug!(%error, "reading local rr lock");
            }
            None
        }
    }
}

/// Blocking OS work: the shell must call this through spawn_blocking.
pub fn read_local() -> Option<RrJob> {
    match current_user() {
        Ok(user) => read_at(Path::new(LOCK_DIR), &user),
        Err(error) => {
            tracing::debug!(%error, "resolving local rr user");
            None
        }
    }
}
