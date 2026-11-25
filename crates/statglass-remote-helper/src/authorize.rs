use std::{
    fs,
    io::{self, Write},
    path::Path,
};

use statglass_remote::{
    AuthorizedKeys, DeviceKeys, DeviceKeysError, DeviceTag, EcdsaP256Public, PairCommands,
    effective_user::EffectiveUser, pairing::ensure_helper_link,
};

pub(crate) fn authorize_key(key: &str, name: &str) -> i32 {
    report((|| {
        let key = EcdsaP256Public::from_base64(key)?;
        let user = EffectiveUser::lookup()?;
        let helper = fs::canonicalize(std::env::current_exe()?)?;
        authorize(&user.home, &helper, &key, name)
    })())
}

fn authorize(
    home: &Path,
    helper: &Path,
    key: &EcdsaP256Public,
    name: &str,
) -> Result<DeviceTag, DeviceKeysError> {
    let bin = home.join("Library/Application Support/com.tryopendata.statglass/bin");
    let link = ensure_helper_link(&bin, helper)?;
    let commands = PairCommands::for_helper(&link)?;
    let keys = AuthorizedKeys::at(home.join(".ssh/authorized_keys"));
    keys.add_device(
        key,
        name,
        &commands.restricted_for(DeviceTag::from_key(key)),
    )
}

pub(crate) fn revoke_key(tag: &str) -> i32 {
    report((|| revoke(&AuthorizedKeys::for_current_user()?, tag))())
}

fn revoke(keys: &AuthorizedKeys, tag: &str) -> Result<DeviceTag, DeviceKeysError> {
    let device = DeviceTag::parse(tag).ok_or_else(|| {
        DeviceKeysError::Invalid("expected a six-digit uppercase hex device tag".into())
    })?;
    keys.revoke(device)?;
    Ok(device)
}

fn report(result: Result<DeviceTag, DeviceKeysError>) -> i32 {
    report_to(result, io::stdout().lock())
}

fn report_to(result: Result<DeviceTag, DeviceKeysError>, mut output: impl Write) -> i32 {
    match result.and_then(|device| Ok(writeln!(output, "{device}")?)) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("statglass-remote-helper: {error}");
            if matches!(error, DeviceKeysError::Invalid(_)) {
                2
            } else {
                1
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use statglass_remote::pairing::link_helper;

    #[test]
    fn authorizing_and_pairing_share_one_stable_restricted_line() {
        let home = tempfile::tempdir().unwrap();
        let bin = home
            .path()
            .join("Library/Application Support/com.tryopendata.statglass/bin");
        let helper = home
            .path()
            .join("StatGlass.app/Contents/MacOS/statglass-remote-helper");
        let key = EcdsaP256Public::from_base64("BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=").unwrap();
        let tag = DeviceTag::from_key(&key);
        let mut output = Vec::new();
        assert_eq!(
            report_to(authorize(home.path(), &helper, &key, "Phone"), &mut output),
            0
        );
        assert_eq!(output, format!("{tag}\n").as_bytes());
        let link = bin.join("statglass-remote-helper");
        assert_eq!(fs::read_link(&link).unwrap(), helper);
        let path = home.path().join(".ssh/authorized_keys");
        let installed = fs::read_to_string(&path).unwrap();
        assert!(installed.starts_with(&format!(
            "restrict,command=\"'{}' restricted --device {tag}\"",
            link.display()
        )));

        let keys = AuthorizedKeys::at(path.clone());
        let pairing = PairCommands::for_helper(&link).unwrap();
        keys.add_device(&key, "Phone", &pairing.restricted_for(tag))
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), installed);

        for _ in 0..2 {
            let mut output = Vec::new();
            assert_eq!(report_to(revoke(&keys, &tag.to_string()), &mut output), 0);
            assert_eq!(output, format!("{tag}\n").as_bytes());
            assert!(fs::read_to_string(&path).unwrap().is_empty());
        }
    }

    #[test]
    fn authorizing_a_device_preserves_the_apps_existing_helper_link() {
        let home = tempfile::tempdir().unwrap();
        let bin = home
            .path()
            .join("Library/Application Support/com.tryopendata.statglass/bin");
        let active = home
            .path()
            .join("Active.app/Contents/MacOS/statglass-remote-helper");
        let old = home
            .path()
            .join("Old.app/Contents/MacOS/statglass-remote-helper");
        fs::create_dir_all(active.parent().unwrap()).unwrap();
        fs::write(&active, b"test helper").unwrap();
        let link = link_helper(&bin, &active).unwrap();
        let key = EcdsaP256Public::from_base64("BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=").unwrap();
        authorize(home.path(), &old, &key, "Phone").unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), active);
    }
}
