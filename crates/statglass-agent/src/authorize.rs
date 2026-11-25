use std::path::Path;

pub(crate) fn authorize_key(_key: &str, _name: &str, _system: bool, _socket: Option<&Path>) -> i32 {
    2
}

pub(crate) fn revoke_key(_tag: &str) -> i32 {
    2
}
