//! Small sysfs/procfs integer readers the Linux collectors share.

/// Parses an unsigned decimal from a short sysfs/procfs value, surrounding whitespace
/// allowed. Never allocates.
pub(super) fn parse_u64(bytes: &[u8]) -> Option<u64> {
    std::str::from_utf8(bytes).ok()?.trim().parse().ok()
}

/// Reads a small file (a sysfs attribute) into `buf` without allocating and parses it as
/// an unsigned integer. `None` when unreadable (an interface gone, `speed` on a link that
/// is down) or not a number (`-1`).
pub(super) fn read_u64_at(path: &std::path::Path) -> Option<u64> {
    use std::io::Read;
    let mut buf = [0u8; 32];
    let mut f = std::fs::File::open(path).ok()?;
    let n = f.read(&mut buf).ok()?;
    parse_u64(buf.get(..n)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_u64_rejects_negative_and_garbage() {
        assert_eq!(parse_u64(b"1000\n"), Some(1000));
        assert_eq!(parse_u64(b"-1\n"), None);
        assert_eq!(parse_u64(b""), None);
    }
}
