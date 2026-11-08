//! The largest actionable folders of a finished scan (plan phase 2b): the deepest folders
//! where a large share of space sits, rather than `Users` or a home folder, which are
//! always the biggest and say nothing about what to clear.
use statglass_schema::disk_space::SpaceCategory;

use super::tree::{NodeId, Tree};

/// Root folders the walk enters: where people's files, apps and installs live. Everything
/// else at the root (the system's own folders, `.Spotlight-V100`, `.fseventsd`, update
/// staging) is not a place to free space.
const ROOTS: [&str; 5] = ["Users", "Applications", "Library", "opt", "usr"];

/// A folder at least `min_bytes` is a highlight when it is a known category, or when its
/// own subfolders of at least `min_bytes` hold less than half of it (its space is its
/// own, not one big child's). Otherwise the walk goes into those subfolders. The root's
/// folders and the home folders are never highlights themselves: the walk always goes
/// through them, since "your home folder is big" says nothing about what to clear.
/// Only finished folders count. Largest first, at most `limit`.
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
        let path = tree.rel_path(id).unwrap_or_default();
        if let Some(category) = category(&path) {
            found.push((id, node.bytes, Some(category)));
            continue;
        }
        let through = match path.as_slice() {
            [] => {
                stack.extend(
                    big.into_iter()
                        .filter(|&kid| tree.get(kid).is_some_and(|k| ROOTS.contains(&&*k.name))),
                );
                continue;
            }
            [_] | ["Users", _] => true,
            _ => false,
        };
        let big_bytes: u64 = big
            .iter()
            .filter_map(|&kid| tree.get(kid))
            .map(|k| k.bytes)
            .sum();
        if through || (!big.is_empty() && big_bytes.saturating_mul(2) >= node.bytes) {
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

    fn files(sizes: &[u64]) -> Vec<FileEntry> {
        sizes
            .iter()
            .enumerate()
            .map(|(i, b)| FileEntry {
                name: format!("f{i}").into(),
                bytes: *b,
            })
            .collect()
    }

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

    fn names_of(tree: &Tree, min: u64) -> Vec<(String, Option<SpaceCategory>)> {
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
            names_of(&tree, GB),
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
        assert_eq!(names_of(&tree, GB), vec![("Users/me/Photos".into(), None)]);
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
            (".Spotlight-V100/store.db", 20 * GB),
        ]);
        assert_eq!(
            names_of(&tree, GB),
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
    fn home_folders_are_walked_through_even_when_their_space_is_spread() {
        // Library and Movies hold under half of the home folder; the rest is in folders
        // under the floor. The home folder is still not the answer.
        let mut files = vec![
            ("Users/me/Library/Caches/blob", 20 * GB),
            ("Users/me/Movies/m.mov", 15 * GB),
        ];
        let names: Vec<String> = (0..60).map(|i| format!("Users/me/d{i}/f")).collect();
        files.extend(names.iter().map(|n| (n.as_str(), GB / 2)));
        let tree = tree(&files);
        assert_eq!(
            names_of(&tree, GB),
            vec![
                (
                    "Users/me/Library/Caches".into(),
                    Some(SpaceCategory::Caches)
                ),
                ("Users/me/Movies".into(), None),
            ]
        );
    }

    #[test]
    fn root_folders_outside_the_walked_ones_are_left_out() {
        let tree = tree(&[
            ("private/var/vm/sleepimage", 30 * GB),
            (".DocumentRevisions-V100/x", 9 * GB),
            ("Library/Developer/CoreSimulator/Volumes/rt", 25 * GB),
            ("opt/homebrew/Cellar/llvm/x", 4 * GB),
        ]);
        assert_eq!(
            names_of(&tree, GB),
            vec![
                (
                    "Library/Developer/CoreSimulator".into(),
                    Some(SpaceCategory::Simulators)
                ),
                ("opt/homebrew/Cellar/llvm".into(), None),
            ]
        );
    }

    #[test]
    fn a_folder_whose_subfolders_were_merged_is_the_highlight() {
        // 300 subfolders of 0.1 GB, each under 0.5% of the folder, merge into its smaller
        // items; the folder keeps its total and nothing below it is kept.
        let names: Vec<String> = (0..300)
            .map(|i| format!("Users/me/Photos/e{i}/f"))
            .collect();
        let files: Vec<(&str, u64)> = names.iter().map(|n| (n.as_str(), GB / 10)).collect();
        let tree = tree(&files);
        assert_eq!(names_of(&tree, GB), vec![("Users/me/Photos".into(), None)]);
    }

    #[test]
    fn unfinished_folders_do_not_count() {
        let (mut tree, root) = Tree::with_root("/");
        let users = tree.record_listing(root, vec!["Users".into()], Vec::new());
        let me = tree.record_listing(users[0], vec!["me".into()], Vec::new());
        let kids = tree.record_listing(me[0], vec!["done".into(), "open".into()], Vec::new());
        tree.record_listing(kids[0], Vec::new(), files(&[3 * GB]));
        // "open" lists a subfolder it never finishes, so it and every folder above it
        // have bytes but aren't done: nothing under them is ranked yet.
        tree.record_listing(kids[1], vec!["deep".into()], files(&[5 * GB]));
        assert!(tree.get(kids[0]).unwrap().done);
        assert!(names_of(&tree, GB).is_empty());
    }

    #[test]
    fn a_truncated_tree_still_ranks_by_exact_totals() {
        let (mut tree, root) = Tree::with_root("/");
        tree.truncated = true;
        let users = tree.record_listing(root, vec!["Users".into()], Vec::new());
        let me = tree.record_listing(users[0], vec!["me".into()], Vec::new());
        let kids = tree.record_listing(me[0], vec!["big".into()], Vec::new());
        // Truncated trees keep no file nodes; the folder's total is still exact.
        tree.record_listing(kids[0], Vec::new(), files(&[4 * GB, 2 * GB]));
        assert_eq!(tree.get(kids[0]).unwrap().bytes, 6 * GB);
        assert_eq!(names_of(&tree, GB), vec![("Users/me/big".into(), None)]);
    }

    #[test]
    fn keeps_the_largest_up_to_the_limit() {
        let names: Vec<String> = (1..=10).map(|i| format!("Users/me/d{i}/f")).collect();
        let files: Vec<(&str, u64)> = names
            .iter()
            .enumerate()
            .map(|(i, n)| (n.as_str(), (i as u64 + 1) * GB))
            .collect();
        let tree = tree(&files);
        let kept: Vec<(NodeId, Option<SpaceCategory>)> = highlights(&tree, GB, 3);
        let kept: Vec<String> = kept
            .into_iter()
            .map(|(id, _)| tree.rel_path(id).unwrap().join("/"))
            .collect();
        assert_eq!(kept, ["Users/me/d10", "Users/me/d9", "Users/me/d8"]);
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
