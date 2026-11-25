use super::KEY_TYPE;

pub(super) struct Entry<'a> {
    pub(super) token: &'a [u8],
    pub(super) key: &'a [u8],
    pub(super) name: &'a [u8],
}

pub(super) fn entries(bytes: &[u8]) -> impl Iterator<Item = Entry<'_>> {
    bytes.split(|&byte| byte == b'\n').filter_map(entry)
}

pub(super) fn entry(line: &[u8]) -> Option<Entry<'_>> {
    let line = line.trim_ascii();
    if line.starts_with(b"#") {
        return None;
    }
    let (first, rest) = field(line)?;
    let key_fields = if first == KEY_TYPE.as_bytes() {
        rest
    } else {
        let (kind, rest) = field(rest)?;
        if kind != KEY_TYPE.as_bytes() {
            return None;
        }
        rest
    };
    let (key, comment) = field(key_fields)?;
    let (token, name) = field(comment).unwrap_or_default();
    Some(Entry { token, key, name })
}

// Whitespace inside quoted key options is part of the field. This mirrors OpenSSH's
// handling of a backslash followed by a double quote, including inside other options.
fn field(line: &[u8]) -> Option<(&[u8], &[u8])> {
    if line.is_empty() {
        return None;
    }
    let mut quoted = false;
    let mut bytes = line.iter().enumerate().peekable();
    while let Some((index, &byte)) = bytes.next() {
        match byte {
            b'\\' if bytes.peek().is_some_and(|&(_, next)| *next == b'"') => {
                bytes.next();
            }
            b'"' => quoted = !quoted,
            b' ' | b'\t' if !quoted => {
                return Some((&line[..index], line[index..].trim_ascii_start()));
            }
            _ => {}
        }
    }
    (!quoted).then_some((line, &[]))
}

pub(super) fn without_token(bytes: &[u8], token: &str) -> Vec<u8> {
    bytes
        .split_inclusive(|&byte| byte == b'\n')
        .filter(|line| entry(line).is_none_or(|entry| entry.token != token.as_bytes()))
        .flatten()
        .copied()
        .collect()
}
