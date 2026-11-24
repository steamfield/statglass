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

test("fails a bundle with two React Native copies and names both", () => {
  assert.deepEqual(runCheck(fixture("two-react-natives")), {
    status: 1,
    stdout: "",
    stderr:
      "single-react: react-native is bundled 2 times:\n" +
      "  /apps/mobile/node_modules/react-native\n" +
      "  /node_modules/react-native\n",
  });
});

test("fails a bundle whose maps list no React at all", () => {
  const dir = fixture("no-react");

  assert.deepEqual(runCheck(dir), {
    status: 1,
    stdout: "",
    stderr: `single-react: react not found in the bundle's source maps under ${dir}\n`,
  });
});

test("fails an export directory with no source maps", () => {
  const dir = fixture("no-maps");

  assert.deepEqual(runCheck(dir), {
    status: 1,
    stdout: "",
    stderr: `single-react: no source maps under ${dir}; export with \`expo export --source-maps\`\n`,
  });
});

test("fails without an export directory argument", () => {
  assert.deepEqual(runCheck(), {
    status: 1,
    stdout: "",
    stderr:
      "single-react: usage: node scripts/mobile/single-react.mjs <expo export dir>\n",
  });
});
