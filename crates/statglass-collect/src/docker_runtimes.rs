//! Finds Docker runtimes installed on this Mac by their app bundles and binaries.
//! Reads only fixed, well-known paths; never runs anything.
use statglass_schema::docker::{DockerRuntimeApp, DockerRuntimeKind};
use std::path::{Path, PathBuf};

/// Where to look: application folders and binary folders.
#[derive(Clone, Debug)]
pub struct SearchPaths {
    /// Folders that hold `.app` bundles.
    pub apps: Vec<PathBuf>,
    /// Folders that hold command-line binaries.
    pub bins: Vec<PathBuf>,
}

/// How a runtime shows up on disk.
enum Marker {
    /// An app bundle directory with this name in an app folder.
    App(&'static str),
    /// A file with this name in a bin folder.
    Bin(&'static str),
}

/// Every runtime StatGlass recognizes, in launch preference order.
const RUNTIMES: [(DockerRuntimeKind, Marker); 4] = [
    (DockerRuntimeKind::DockerDesktop, Marker::App("Docker.app")),
    (DockerRuntimeKind::OrbStack, Marker::App("OrbStack.app")),
    (
        DockerRuntimeKind::RancherDesktop,
        Marker::App("Rancher Desktop.app"),
    ),
    (DockerRuntimeKind::Colima, Marker::Bin("colima")),
];

/// The standard places: `/Applications`, `~/Applications`, `/opt/homebrew/bin`,
/// `/usr/local/bin`.
pub fn default_search_paths(home: &Path) -> SearchPaths {
    SearchPaths {
        apps: vec![PathBuf::from("/Applications"), home.join("Applications")],
        bins: vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ],
    }
}

/// The LaunchServices bundle id that opens a runtime app; `None` for Colima.
pub fn bundle_id(kind: DockerRuntimeKind) -> Option<&'static str> {
    match kind {
        DockerRuntimeKind::DockerDesktop => Some("com.docker.docker"),
        DockerRuntimeKind::OrbStack => Some("dev.kdrag0n.MacVirt"),
        DockerRuntimeKind::RancherDesktop => Some("io.rancherdesktop.app"),
        DockerRuntimeKind::Colima => None,
    }
}

/// The name the UI shows for a runtime, e.g. "Docker Desktop".
pub fn display_name(kind: DockerRuntimeKind) -> &'static str {
    match kind {
        DockerRuntimeKind::DockerDesktop => "Docker Desktop",
        DockerRuntimeKind::OrbStack => "OrbStack",
        DockerRuntimeKind::RancherDesktop => "Rancher Desktop",
        DockerRuntimeKind::Colima => "Colima",
    }
}

/// Installed runtimes in launch preference order: Docker Desktop (`Docker.app`),
/// OrbStack (`OrbStack.app`), Rancher Desktop (`Rancher Desktop.app`), Colima (a
/// `colima` file in a bin folder). Each kind appears once; app bundles are directories,
/// and symlinked bundles or binaries count.
pub fn installed_runtimes(paths: &SearchPaths) -> Vec<DockerRuntimeApp> {
    RUNTIMES
        .iter()
        .filter(|(_, marker)| is_present(marker, paths))
        .map(|(kind, _)| DockerRuntimeApp {
            kind: *kind,
            name: display_name(*kind).into(),
            launchable: bundle_id(*kind).is_some(),
        })
        .collect()
}

/// Whether the marker exists in any of its folders. `Path::is_dir` and `is_file`
/// follow symlinks, and an unreadable path counts as absent.
fn is_present(marker: &Marker, paths: &SearchPaths) -> bool {
    match marker {
        Marker::App(name) => paths.apps.iter().any(|dir| dir.join(name).is_dir()),
        Marker::Bin(name) => paths.bins.iter().any(|dir| dir.join(name).is_file()),
    }
}

#[cfg(test)]
mod tests;
