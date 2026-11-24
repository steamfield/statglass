/**
 * scripts/mobile/single-react.mjs run as the mobile check runs it, against
 * fixture export directories. Run with `node --test`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "single-react.mjs");
const fixture = (name) => path.join(here, "single-react", name);

function runCheck(...args) {
  const run = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("passes a bundle with one React and one React Native", () => {
  assert.deepEqual(runCheck(fixture("one-copy")), {
    status: 0,
    stdout: "single-react: one copy each of react, react-native\n",
    stderr: "",
  });
});

test("fails a bundle with two React copies and names both", () => {
  assert.deepEqual(runCheck(fixture("two-copies")), {
    status: 1,
    stdout: "",
    stderr:
      "single-react: react is bundled 2 times:\n" +
      "  /apps/mobile/node_modules/react\n" +
      "  /node_modules/react\n",
  });
});

test("fails an export directory with no source maps", () => {
  const run = runCheck(fixture("no-maps"));

  assert.equal(run.status, 1);
  assert.match(run.stderr, /no source maps under .*no-maps/);
});

test("fails without an export directory argument", () => {
  const run = runCheck();

  assert.equal(run.status, 1);
  assert.match(run.stderr, /usage: node scripts\/mobile\/single-react\.mjs/);
});
