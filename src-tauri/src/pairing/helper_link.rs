use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

use anyhow::{Context, ensure};
use statglass_remote::{PairCommands, SocketPaths, pairing::link_helper as repoint};

const HELPER: &str = "statglass-remote-helper";

fn check_control_socket(app: &Path, helper: &Path) -> anyhow::Result<()> {
    ensure!(
        app == helper,
        "This build uses a different SSH control socket. Open an installed copy of StatGlass and try again."
    );
    Ok(())
}

pub(super) fn install(data_dir: &Path) -> anyhow::Result<PairCommands> {
    let helper =
        SocketPaths::for_current_user().context("finding the SSH helper's control socket")?;
    check_control_socket(&SocketPaths::new(data_dir).control, &helper.control)?;
    let app = std::env::current_exe().context("finding the running StatGlass app")?;
    let target = bundled_helper(&app).context(
        "This build has no bundled SSH helper. Open an installed copy of StatGlass and try again",
    )?;
    let link = repoint(&data_dir.join("bin"), &target).context("linking the SSH helper")?;
    Ok(PairCommands::for_helper(&link)?)
}

fn bundled_helper(app: &Path) -> Option<PathBuf> {
    let macos = app.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let target = macos.join(HELPER);
    (macos.ends_with("MacOS")
        && contents.ends_with("Contents")
        && bundle
            .extension()
            .is_some_and(|extension| extension == "app")
        && fs::metadata(&target).is_ok_and(|meta| meta.is_file() && meta.mode() & 0o111 != 0))
    .then_some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_helper_link_is_stable_across_bundle_moves() {
        let dir = tempfile::tempdir().unwrap();
        let link_dir = dir
            .path()
            .join("Application Support/com.tryopendata.statglass/bin");
        let old = dir.path().join("Old.app/Contents/MacOS").join(HELPER);
        let new = dir.path().join("StatGlass.app/Contents/MacOS").join(HELPER);
        let link = repoint(&link_dir, &old).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), old);
        assert_eq!(repoint(&link_dir, &new).unwrap(), link);
        assert_eq!(fs::read_link(&link).unwrap(), new);
        assert_eq!(fs::read_dir(link_dir).unwrap().count(), 1);
    }

    #[test]
    fn pairing_helper_rejects_a_build_that_serves_a_different_control_socket() {
        let app_data = Path::new("/user/Library/Application Support");
        let release = app_data.join("com.tryopendata.statglass/remote/control.sock");
        let debug = app_data.join("com.tryopendata.statglass.dev/remote/control.sock");
        check_control_socket(&release, &release).unwrap();
        assert!(
            check_control_socket(&debug, &release)
                .unwrap_err()
                .to_string()
                .contains("installed copy")
        );
    }
}
