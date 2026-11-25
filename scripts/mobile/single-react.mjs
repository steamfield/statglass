#!/usr/bin/env node
/**
 * Fails when an exported mobile bundle contains more than one copy of React or
 * React Native. Usage: `node scripts/mobile/single-react.mjs <export dir>`.
 *
 * Production bundles number their modules instead of naming them, so the check
 * reads the source maps `expo export --source-maps` writes next to each bundle:
 * every module's file path is in a map's `sources`. Two copies show up as two
 * different `node_modules/<package>` directories.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Packages that must be bundled exactly once. */
const SINGLE_COPY_PACKAGES = ["react", "react-native"];

const SOURCE_MAP = /\.map$/;

/** A failed check or bad input; the message alone explains it. */
class CheckError extends Error {
  name = "CheckError";
}

/**
 * The installed directory of `packageName` that `sourcePath` belongs to, or
 * null when the file is not part of that package.
 * @param {string} sourcePath
 * @param {string} packageName
 */
function packageRoot(sourcePath, packageName) {
  const marker = `node_modules/${packageName}/`;
  const at = sourcePath.replaceAll("\\", "/").lastIndexOf(marker);
  if (at === -1) return null;
  return sourcePath.slice(0, at + marker.length - 1);
}

/**
 * For each single-copy package, the distinct directories it was bundled from.
 * @param {Iterable<string>} sourcePaths every module path in the bundle
 * @returns {Map<string, string[]>}
 */
function bundledCopies(sourcePaths) {
  const copies = new Map(SINGLE_COPY_PACKAGES.map((name) => [name, new Set()]));
  for (const sourcePath of sourcePaths) {
    for (const [name, roots] of copies) {
      const root = packageRoot(sourcePath, name);
      if (root) roots.add(root);
    }
  }
  return new Map([...copies].map(([name, roots]) => [name, [...roots].sort()]));
}

/**
 * Every source map under `dir`, recursively.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function sourceMapsIn(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SOURCE_MAP.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * The module paths one source map lists.
 * @param {string} mapFile
 * @throws {CheckError} when the file is not a JSON source map
 */
async function sourcesOf(mapFile) {
  let map;
  try {
    map = JSON.parse(await readFile(mapFile, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new CheckError(`${mapFile} is not JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (!Array.isArray(map.sources)) {
    throw new CheckError(
      `${mapFile} has no "sources" array; is it a source map?`
    );
  }
  return map.sources;
}

/**
 * Report lines for packages bundled more than once; empty when the bundle is clean.
 * @param {Map<string, string[]>} copies
 */
function duplicateReport(copies) {
  return [...copies]
    .filter(([, roots]) => roots.length > 1)
    .map(
      ([name, roots]) =>
        `${name} is bundled ${roots.length} times:\n  ${roots.join("\n  ")}`
    );
}

async function main() {
  const exportDir = process.argv[2];
  if (!exportDir) {
    throw new CheckError(
      "usage: node scripts/mobile/single-react.mjs <expo export dir>"
    );
  }
  const maps = await sourceMapsIn(exportDir);
  if (maps.length === 0) {
    throw new CheckError(
      `no source maps under ${exportDir}; export with \`expo export --source-maps\``
    );
  }
  const sources = (await Promise.all(maps.map(sourcesOf))).flat();
  const copies = bundledCopies(sources);
  const missing = SINGLE_COPY_PACKAGES.filter(
    (name) => copies.get(name).length === 0
  );
  if (missing.length > 0) {
    throw new CheckError(
      `${missing.join(" and ")} not found in the bundle's source maps under ${exportDir}`
    );
  }
  const duplicates = duplicateReport(copies);
  if (duplicates.length > 0) {
    console.error(`single-react: ${duplicates.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `single-react: one copy each of ${SINGLE_COPY_PACKAGES.join(", ")}`
  );
}

main().catch((error) => {
  const detail = error instanceof CheckError ? error.message : error.stack;
  console.error(`single-react: ${detail}`);
  process.exitCode = 1;
});
