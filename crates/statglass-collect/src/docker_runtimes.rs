//! Finds Docker runtimes installed on this Mac by their app bundles and binaries.
//! Reads only fixed, well-known paths; never runs anything.
use statglass_schema::docker::{DockerRuntimeApp, DockerRuntimeKind};
use std::path::{Path, PathBuf};

/// Where to look: application folders and binary folders.
#[derive(Clone, Debug)]
pub struct SearchPaths {
    pub apps: Vec<PathBuf>,
    pub bins: Vec<PathBuf>,
}

/// The standard places: `/Applications`, `~/Applications`, `/opt/homebrew/bin`,
/// `/usr/local/bin`.
pub fn default_search_paths(home: &Path) -> SearchPaths {
    let _ = home;
    SearchPaths {
        apps: Vec::new(),
        bins: Vec::new(),
    }
}

/// The LaunchServices bundle id that opens a runtime app; `None` for Colima.
pub fn bundle_id(kind: DockerRuntimeKind) -> Option<&'static str> {
    let _ = kind;
    None
}

/// Installed runtimes in launch preference order: Docker Desktop (`Docker.app`),
/// OrbStack (`OrbStack.app`), Rancher Desktop (`Rancher Desktop.app`), Colima (a
/// `colima` file in a bin folder). Each kind appears once; app bundles are directories,
/// and symlinked bundles or binaries count.
pub fn installed_runtimes(paths: &SearchPaths) -> Vec<DockerRuntimeApp> {
    let _ = paths;
    Vec::new()
}

#[cfg(test)]
mod tests;
