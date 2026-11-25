use std::{
    fs::{self, DirBuilder},
    io,
    os::unix::fs::{DirBuilderExt, MetadataExt, symlink},
    path::{Path, PathBuf},
};

fn link_path(directory: &Path) -> io::Result<PathBuf> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    let meta = fs::symlink_metadata(directory)?;
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o022 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "{} must be a directory owned by you and writable only by you",
                directory.display()
            ),
        ));
    }
    Ok(directory.join("statglass-remote-helper"))
}

/// Keeps the helper path written to authorized_keys stable across app bundle moves.
pub fn link_helper(directory: &Path, target: &Path) -> io::Result<PathBuf> {
    let link = link_path(directory)?;
    match fs::read_link(&link) {
        Ok(existing) if existing == target => return Ok(link),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let staged = directory.join(format!(".statglass-remote-helper-{}", uuid::Uuid::new_v4()));
    symlink(target, &staged)?;
    if let Err(error) = fs::rename(&staged, &link) {
        if let Err(cleanup) = fs::remove_file(&staged) {
            tracing::warn!(path = %staged.display(), %cleanup, "removing staged SSH helper link");
        }
        return Err(error);
    }
    Ok(link)
}

/// Lets a fresh host authorize a device before the app has created its pairing link.
/// An existing link stays under the app's control.
pub fn ensure_helper_link(directory: &Path, target: &Path) -> io::Result<PathBuf> {
    let link = link_path(directory)?;
    match symlink(target, &link) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            fs::read_link(&link)?;
        }
        Err(error) => return Err(error),
    }
    Ok(link)
}
