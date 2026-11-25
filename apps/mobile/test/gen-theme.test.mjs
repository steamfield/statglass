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
import { MOTION } from "./motion-css-fixture.mjs";

const script = path.resolve(import.meta.dirname, "../scripts/gen-theme.mjs");

const THEME = `@theme static { --color-background: #fafafa; }
.dark { --color-background: #09090b; }
`;

let workDir = "";
let source = "";
let motionSource = "";
let outDir = "";

beforeEach(async () => {
  // realpath: macOS's temp dir is a symlink, and the script prints paths
  // relative to its resolved working directory.
  workDir = await realpath(await mkdtemp(path.join(tmpdir(), "gen-theme-")));
  source = path.join(workDir, "theme.css");
  motionSource = path.join(workDir, "motion.css");
  outDir = path.join(workDir, "out");
  await writeFile(source, THEME);
  await writeFile(motionSource, MOTION);
  await mkdir(outDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** @param {...string} args */
function genTheme(...args) {
  const run = spawnSync(
    process.execPath,
    [
      script,
      "--source",
      source,
      "--motion-source",
      motionSource,
      "--out",
      outDir,
      ...args,
    ],
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

test("writes the stylesheet, color map and motion tokens, then --check passes", async () => {
  assert.equal(genTheme().status, 0);
  const written = await outputFiles();

  assert.deepEqual(Object.keys(written), [
    "theme.generated.css",
    "theme.generated.ts",
  ]);
  assert.match(written["theme.generated.css"], /--color-background: #fafafa;/);
  assert.match(
    written["theme.generated.ts"],
    /motionDurations = \{\n {2}tick: 175,/
  );
  assert.match(
    written["theme.generated.ts"],
    /easeTick: \[0\.33, 1, 0\.68, 1\],/
  );
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
    /^gen-theme: mobile theme is missing or out of date with theme\.css or motion\.css: out\/theme\.generated\.css\. Run/
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

for (const [from, to] of /** @type {const} */ ([
  ["175ms", "200ms"],
  ["0.68, 1", "0.7, 1"],
])) {
  test(`--check catches a motion source change from ${from}`, async () => {
    assert.equal(genTheme().status, 0);
    const written = await outputFiles();
    await writeFile(motionSource, MOTION.replace(from, to));

    const run = genTheme("--check");

    assert.equal(run.status, 1);
    assert.match(run.stderr, /motion\.css: out\/theme\.generated\.ts\. Run/);
    assert.deepEqual(await outputFiles(), written);
  });
}

for (const [from, to, error] of /** @type {const} */ ([
  ["175ms", "175px", '--motion-tick "175px" is not a duration'],
  [
    "175ms",
    "calc(\n  175ms\n)",
    '--motion-tick "calc(\\n  175ms\\n)" is not a duration',
  ],
  [
    "cubic-bezier(0.33, 1, 0.68, 1)",
    "linear",
    '--ease-tick "linear" is not a cubic-bezier curve',
  ],
])) {
  test(`reports malformed motion (${JSON.stringify(to)}) on one line`, async () => {
    await writeFile(motionSource, MOTION.replace(from, to));

    assert.deepEqual(genTheme("--check"), {
      status: 1,
      stdout: "",
      stderr: `gen-theme: motion.css: ${error}\n`,
    });
  });
}
