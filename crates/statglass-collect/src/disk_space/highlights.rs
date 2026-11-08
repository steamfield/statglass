//! The largest actionable folders of a finished scan (plan phase 2b): the deepest folders
//! where a large share of space sits, rather than `Users` or a home folder, which are
//! always the biggest and say nothing about what to clear.
use statglass_schema::disk_space::SpaceCategory;

use super::tree::{NodeId, Tree};

/// Folders at the volume root the system owns; not offered as places to free space.
const SYSTEM_ROOTS: [&str; 10] = [
    "System", "private", "usr", "bin", "sbin", "cores", "opt", "Library", "dev", "Volumes",
];

/// A folder at least `min_bytes` is a highlight when it is a known category, or when its
/// own subfolders of at least `min_bytes` hold less than half of it (its space is its
/// own, not one big child's). Otherwise the walk goes into those subfolders. Largest
/// first, at most `limit`.
pub(crate) fn highlights(
    tree: &Tree,
    min_bytes: u64,
    limit: usize,
) -> Vec<(NodeId, Option<SpaceCategory>)> {
    let mut found = Vec::new();
    let mut stack = vec![0];
    while let Some(id) = stack.pop() {
        let Some(node) = tree.get(id) else { continue };
        let big: Vec<NodeId> = node
            .children
            .iter()
            .copied()
            .filter(|&kid| {
                tree.get(kid)
                    .is_some_and(|k| k.dir && k.done && k.bytes >= min_bytes)
            })
            .collect();
        if id == 0 {
            stack.extend(big.into_iter().filter(|&kid| {
                tree.get(kid)
                    .is_some_and(|k| !SYSTEM_ROOTS.contains(&&*k.name))
            }));
            continue;
        }
        let path = tree.rel_path(id).unwrap_or_default();
        if let Some(category) = category(&path) {
            found.push((id, node.bytes, Some(category)));
            continue;
        }
        let big_bytes: u64 = big
            .iter()
            .filter_map(|&kid| tree.get(kid))
            .map(|k| k.bytes)
            .sum();
        if big_bytes.saturating_mul(2) >= node.bytes && !big.is_empty() {
            stack.extend(big);
        } else {
            found.push((id, node.bytes, None));
        }
    }
    found.sort_by_key(|&(id, bytes, _)| (std::cmp::Reverse(bytes), id));
    found.truncate(limit);
    found.into_iter().map(|(id, _, c)| (id, c)).collect()
}

/// The category of a volume-relative folder path, by its last components.
pub(crate) fn category(path: &[&str]) -> Option<SpaceCategory> {
    let ends = |suffix: &[&str]| path.ends_with(suffix);
    let last = *path.last()?;
    let parent = path.len().checked_sub(2).and_then(|i| path.get(i)).copied();
    Some(match last {
        "DerivedData" if ends(&["Developer", "Xcode", "DerivedData"]) => SpaceCategory::XcodeBuilds,
        "Archives" if ends(&["Developer", "Xcode", "Archives"]) => SpaceCategory::XcodeArchives,
        name if name.ends_with(" DeviceSupport") && parent == Some("Xcode") => {
            SpaceCategory::DeviceSupport
        }
        "CoreSimulator" if ends(&["Library", "Developer", "CoreSimulator"]) => {
            SpaceCategory::Simulators
        }
        "node_modules" => SpaceCategory::NodeModules,
        "Caches" if path.len() == 4 && ends(&["Library", "Caches"]) => SpaceCategory::Caches,
        ".Trash" => SpaceCategory::Trash,
        "com.docker.docker" if parent == Some("Containers") => SpaceCategory::ContainerData,
        ".orbstack" => SpaceCategory::ContainerData,
        name if name.ends_with(".dev.orbstack") && parent == Some("Group Containers") => {
            SpaceCategory::ContainerData
        }
        "huggingface" if parent == Some(".cache") => SpaceCategory::Models,
        "models" if parent == Some(".ollama") => SpaceCategory::Models,
        "Downloads" if path.len() == 3 && path.first() == Some(&"Users") => {
            SpaceCategory::Downloads
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::super::tree::FileEntry;
    use super::*;

    const GB: u64 = 1 << 30;

    #[derive(Default)]
    struct Dir {
        dirs: std::collections::BTreeMap<String, Dir>,
        files: Vec<(String, u64)>,
    }

    /// A finished tree from `(path, bytes)` files; folders are created along the way.
    fn tree(files: &[(&str, u64)]) -> Tree {
        let mut top = Dir::default();
        for (path, bytes) in files {
            let mut parts: Vec<&str> = path.split('/').collect();
            let name = parts.pop().unwrap();
            let dir = parts.into_iter().fold(&mut top, |d, part| {
                d.dirs.entry(part.to_owned()).or_default()
            });
            dir.files.push((name.to_owned(), *bytes));
        }
        let (mut tree, root) = Tree::with_root("/");
        record(&mut tree, root, &top);
        assert!(tree.get(root).unwrap().done);
        tree
    }

    fn record(tree: &mut Tree, id: NodeId, dir: &Dir) {
        let files = dir
            .files
            .iter()
            .map(|(name, bytes)| FileEntry {
                name: name.as_str().into(),
                bytes: *bytes,
            })
            .collect();
        let kids = tree.record_listing(
            id,
            dir.dirs.keys().map(|k| k.as_str().into()).collect(),
            files,
        );
        for (kid, sub) in kids.into_iter().zip(dir.dirs.values()) {
            record(tree, kid, sub);
        }
    }

    fn names(tree: &Tree, min: u64) -> Vec<(String, Option<SpaceCategory>)> {
        highlights(tree, min, 8)
            .into_iter()
            .map(|(id, c)| (tree.rel_path(id).unwrap().join("/"), c))
            .collect()
    }

    #[test]
    fn descends_past_folders_one_big_child_explains() {
        let tree = tree(&[
            ("Users/me/Projects/game/assets/a.bin", 30 * GB),
            ("Users/me/Projects/game/assets/b.bin", 20 * GB),
            ("Users/me/Movies/m.mov", 10 * GB),
            ("Users/me/notes.txt", GB / 2),
        ]);
        assert_eq!(
            names(&tree, GB),
            vec![
                ("Users/me/Projects/game/assets".into(), None),
                ("Users/me/Movies".into(), None),
            ]
        );
    }

    #[test]
    fn a_folder_whose_space_is_its_own_is_the_highlight() {
        let tree = tree(&[
            ("Users/me/Photos/a.jpg", 3 * GB),
            ("Users/me/Photos/b.jpg", 3 * GB),
            ("Users/me/Photos/small/c.jpg", 2 * GB),
        ]);
        assert_eq!(names(&tree, GB), vec![("Users/me/Photos".into(), None)]);
    }

    #[test]
    fn known_locations_stop_the_walk_and_carry_their_category() {
        let tree = tree(&[
            (
                "Users/me/Library/Developer/Xcode/DerivedData/App-x/Build/a",
                40 * GB,
            ),
            ("Users/me/Library/Caches/com.app/blob", 5 * GB),
            ("Users/me/code/web/node_modules/pkg/index.js", 3 * GB),
            ("System/Library/huge", 90 * GB),
        ]);
        assert_eq!(
            names(&tree, GB),
            vec![
                (
                    "Users/me/Library/Developer/Xcode/DerivedData".into(),
                    Some(SpaceCategory::XcodeBuilds)
                ),
                (
                    "Users/me/Library/Caches".into(),
                    Some(SpaceCategory::Caches)
                ),
                (
                    "Users/me/code/web/node_modules".into(),
                    Some(SpaceCategory::NodeModules)
                ),
            ]
        );
    }

    #[test]
    fn categories_match_by_path_suffix() {
        let cat = |p: &str| category(&p.split('/').collect::<Vec<_>>());
        assert_eq!(cat("Users/me/Downloads"), Some(SpaceCategory::Downloads));
        assert_eq!(cat("Users/me/x/Downloads"), None);
        assert_eq!(cat("Library/Caches"), None);
        assert_eq!(
            cat("Users/me/Library/Developer/Xcode/iOS DeviceSupport"),
            Some(SpaceCategory::DeviceSupport)
        );
        assert_eq!(
            cat("Users/me/Library/Group Containers/HUAQ24HBR6.dev.orbstack"),
            Some(SpaceCategory::ContainerData)
        );
        assert_eq!(cat("Users/me/.ollama/models"), Some(SpaceCategory::Models));
        assert_eq!(cat("Users/me/models"), None);
    }
}
