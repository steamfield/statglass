use super::*;
use DockerRuntimeKind as K;

fn paths(root: &Path) -> SearchPaths {
    SearchPaths {
        apps: vec![root.join("Applications"), root.join("home/Applications")],
        bins: vec![root.join("opt/homebrew/bin"), root.join("usr/local/bin")],
    }
}

fn app(root: &Path, dir: &str, name: &str) {
    std::fs::create_dir_all(root.join(dir).join(name).join("Contents")).unwrap();
}

fn bin(root: &Path, dir: &str) {
    std::fs::create_dir_all(root.join(dir)).unwrap();
    std::fs::write(root.join(dir).join("colima"), b"#!/bin/sh\n").unwrap();
}

#[test]
fn an_empty_mac_has_no_runtimes() {
    let dir = tempfile::tempdir().unwrap();
    assert!(installed_runtimes(&paths(dir.path())).is_empty());
}

#[test]
fn runtimes_come_back_in_launch_preference_order() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    bin(root, "opt/homebrew/bin");
    app(root, "home/Applications", "Rancher Desktop.app");
    app(root, "Applications", "OrbStack.app");
    app(root, "Applications", "Docker.app");
    let found = installed_runtimes(&paths(root));
    let kinds: Vec<_> = found.iter().map(|r| r.kind).collect();
    assert_eq!(
        kinds,
        [K::DockerDesktop, K::OrbStack, K::RancherDesktop, K::Colima]
    );
    assert_eq!(found[0].name, "Docker Desktop");
    assert!(found[0].launchable && found[1].launchable && found[2].launchable);
    assert!(!found[3].launchable, "Colima has no app to open");
}

#[test]
fn an_app_in_two_folders_is_listed_once() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    app(root, "Applications", "Docker.app");
    app(root, "home/Applications", "Docker.app");
    bin(root, "opt/homebrew/bin");
    bin(root, "usr/local/bin");
    let kinds: Vec<_> = installed_runtimes(&paths(root))
        .iter()
        .map(|r| r.kind)
        .collect();
    assert_eq!(kinds, [K::DockerDesktop, K::Colima]);
}

#[test]
fn a_plain_file_named_like_an_app_is_not_an_app() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("Applications")).unwrap();
    std::fs::write(root.join("Applications/Docker.app"), b"").unwrap();
    assert!(installed_runtimes(&paths(root)).is_empty());
}

#[test]
fn symlinked_bundles_count() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    app(root, "elsewhere", "OrbStack.app");
    std::fs::create_dir_all(root.join("Applications")).unwrap();
    std::os::unix::fs::symlink(
        root.join("elsewhere/OrbStack.app"),
        root.join("Applications/OrbStack.app"),
    )
    .unwrap();
    let kinds: Vec<_> = installed_runtimes(&paths(root))
        .iter()
        .map(|r| r.kind)
        .collect();
    assert_eq!(kinds, [K::OrbStack]);
}

#[test]
fn bundle_ids_cover_the_apps_only() {
    assert_eq!(bundle_id(K::DockerDesktop), Some("com.docker.docker"));
    assert_eq!(bundle_id(K::OrbStack), Some("dev.kdrag0n.MacVirt"));
    assert_eq!(bundle_id(K::RancherDesktop), Some("io.rancherdesktop.app"));
    assert_eq!(bundle_id(K::Colima), None);
}

#[test]
fn default_paths_include_the_standard_folders() {
    let p = default_search_paths(Path::new("/Users/me"));
    assert!(p.apps.contains(&PathBuf::from("/Applications")));
    assert!(p.apps.contains(&PathBuf::from("/Users/me/Applications")));
    assert!(p.bins.contains(&PathBuf::from("/opt/homebrew/bin")));
    assert!(p.bins.contains(&PathBuf::from("/usr/local/bin")));
}
