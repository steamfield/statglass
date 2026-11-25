use std::{
    io::{self, Write},
    path::Path,
};

use anyhow::Context;
use statglass_remote::{
    AgentEnv, AgentLayout, AuthorizedKeys, DeviceKeys, DeviceKeysError, DeviceTag, EcdsaP256Public,
    effective_user::EffectiveUser,
};

use crate::pair::{commands_at, pairing_env};

pub(crate) fn authorize_key(key: &str, name: &str, system: bool, socket: Option<&Path>) -> i32 {
    report(authorize(key, name, system, socket))
}

fn authorize(
    key: &str,
    name: &str,
    system: bool,
    socket: Option<&Path>,
) -> anyhow::Result<DeviceTag> {
    let key = EcdsaP256Public::from_base64(key)?;
    let tag = DeviceTag::from_key(&key);
    let user = EffectiveUser::lookup().context("locating the SSH account")?;
    let uid = rustix::process::geteuid().as_raw();
    let layout = if system {
        AgentLayout::System
    } else {
        AgentLayout::for_uid(uid)
    };
    let keys = AuthorizedKeys::at(user.home.join(".ssh/authorized_keys"));
    let env = pairing_env(AgentEnv::from_process(), user.home, uid);
    let paths = layout.paths(&env).context("locating this host's agent")?;
    let commands = commands_at(layout, &paths, &env, socket)?;
    keys.add_device(&key, name, &commands.restricted_for(tag))
        .context("authorizing the device")
}

pub(crate) fn revoke_key(tag: &str) -> i32 {
    report((|| {
        let device = DeviceTag::parse(tag).ok_or_else(|| {
            DeviceKeysError::Invalid("expected a six-digit uppercase hex device tag".into())
        })?;
        AuthorizedKeys::for_current_user()?
            .revoke(device)
            .with_context(|| format!("revoking device {device}"))?;
        Ok(device)
    })())
}

fn report(result: anyhow::Result<DeviceTag>) -> i32 {
    match result.and_then(|device| {
        writeln!(io::stdout().lock(), "{device}").context("writing the device tag")
    }) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("statglass-agent: {error:#}");
            if matches!(
                error.downcast_ref::<DeviceKeysError>(),
                Some(DeviceKeysError::Invalid(_))
            ) {
                2
            } else {
                1
            }
        }
    }
}
