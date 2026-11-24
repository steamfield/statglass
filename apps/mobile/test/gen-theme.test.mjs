/**
 * gen-theme.mjs as a command: writing the theme files, and `--check` on
 * fresh, stale and missing output. Each check must leave the files as it found
 * them. Plain Node (`node --test`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const script = path.resolve(import.meta.dirname, "../scripts/gen-theme.mjs");

const THEME = `@theme static { --color-background: #fafafa; }
.dark { --color-background: #09090b; }
`;

let workDir = "";
let source = "";
let outDir = "";

beforeEach(async () => {
  // realpath: macOS's temp dir is a symlink, and the script prints paths
  // relative to its resolved working directory.
  workDir = await realpath(await mkdtemp(path.join(tmpdir(), "gen-theme-")));
  source = path.join(workDir, "theme.css");
  outDir = path.join(workDir, "out");
  await writeFile(source, THEME);
  await mkdir(outDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** @param {...string} args */
function genTheme(...args) {
  const run = spawnSync(
    process.execPath,
    [script, "--source", source, "--out", outDir, ...args],
    { cwd: workDir, encoding: "utf8" }
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** Every file in the output directory with its contents. */
async function outputFiles() {
  const names = (await readdir(outDir)).sort();
  const entries = await Promise.all(
    names.map(async (name) => [
      name,
      await readFile(path.join(outDir, name), "utf8"),
    ])
  );
  return Object.fromEntries(entries);
}

test("writes the stylesheet and the color map, then --check passes", async () => {
  assert.equal(genTheme().status, 0);
  const written = await outputFiles();

  assert.deepEqual(Object.keys(written), [
    "theme.generated.css",
    "theme.generated.ts",
  ]);
  assert.match(written["theme.generated.css"], /--color-background: #fafafa;/);
  assert.deepEqual(genTheme("--check"), { status: 0, stdout: "", stderr: "" });
  assert.deepEqual(await outputFiles(), written);
});

test("--check fails on a stale file, names it and leaves it alone", async () => {
  genTheme();
  await writeFile(path.join(outDir, "theme.generated.css"), "/* edited */\n");
  const before = await outputFiles();

  const run = genTheme("--check");

  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.match(
    run.stderr,
    /^gen-theme: mobile theme is missing or out of date with theme\.css: out\/theme\.generated\.css\. Run/
  );
  assert.deepEqual(await outputFiles(), before);
});

test("--check fails when the files are missing and writes nothing", async () => {
  const run = genTheme("--check");

  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    /out\/theme\.generated\.css, out\/theme\.generated\.ts\. Run/
  );
  assert.deepEqual(await outputFiles(), {});
});

test("reports a broken theme in one line, without a stack", async () => {
  await writeFile(source, "@theme static { --color-a: #000; }\n");

  const run = genTheme("--check");

  assert.deepEqual(run, {
    status: 1,
    stdout: "",
    stderr: "gen-theme: theme.css has no top-level .dark block\n",
  });
});
