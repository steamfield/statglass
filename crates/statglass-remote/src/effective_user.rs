//! Account identity for SSH pairing and the user's authorized keys.

use std::{
    ffi::{CStr, OsString},
    io,
    mem::MaybeUninit,
    os::unix::ffi::OsStringExt,
    path::PathBuf,
    ptr,
};

/// The passwd entry for the process's effective user.
pub struct EffectiveUser {
    pub home: PathBuf,
    pub name: OsString,
}

impl EffectiveUser {
    /// Looks up the effective uid through the system account database.
    ///
    /// # Errors
    ///
    /// Returns an I/O error if the lookup fails or the account has no usable entry.
    pub fn lookup() -> io::Result<Self> {
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        let mut buffer = vec![0u8; 1024];
        loop {
            let mut entry = MaybeUninit::<libc::passwd>::uninit();
            let mut found = ptr::null_mut();
            // SAFETY: All output pointers refer to writable storage for this call.
            let error = unsafe {
                libc::getpwuid_r(
                    uid,
                    entry.as_mut_ptr(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut found,
                )
            };
            match error {
                libc::ERANGE => buffer.resize(buffer.len() * 2, 0),
                0 if found.is_null() => {
                    return Err(io::Error::new(
                        io::ErrorKind::NotFound,
                        format!("no passwd entry for effective uid {uid}"),
                    ));
                }
                0 => {
                    // SAFETY: getpwuid_r initialized the entry and reported a match.
                    let entry = unsafe { entry.assume_init() };
                    let invalid_entry = || {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!(
                                "invalid home or login in passwd entry for effective uid {uid}"
                            ),
                        )
                    };
                    if entry.pw_dir.is_null() || entry.pw_name.is_null() {
                        return Err(invalid_entry());
                    }
                    // SAFETY: The non-null strings are NUL-terminated and valid while
                    // the passwd buffer lives. Both strings are copied here.
                    let (home, name) = unsafe {
                        (
                            OsString::from_vec(CStr::from_ptr(entry.pw_dir).to_bytes().to_vec()),
                            OsString::from_vec(CStr::from_ptr(entry.pw_name).to_bytes().to_vec()),
                        )
                    };
                    let home = PathBuf::from(home);
                    if !home.is_absolute() || name.is_empty() {
                        return Err(invalid_entry());
                    }
                    return Ok(Self { home, name });
                }
                error => {
                    return Err(io::Error::new(
                        io::Error::from_raw_os_error(error).kind(),
                        format!(
                            "looking up effective uid {uid}: {}",
                            io::Error::from_raw_os_error(error)
                        ),
                    ));
                }
            }
        }
    }
}
