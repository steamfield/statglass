#!/usr/bin/env node
/**
 * Writes apps/mobile/src/theme.generated.css and theme.generated.ts from the
 * desktop's src/app/styles/theme.css. With `--check` it writes nothing and
 * exits 1 when either committed file differs from what it would write.
 *
 * NativeWind cannot import theme.css itself: its dark values sit under a
 * `.dark` class and a class-based `dark` variant, which the native compiler
 * rejects in favor of `prefers-color-scheme`.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderColorModule, renderThemeCss } from "./theme-render.mjs";
import { readSchemeColors } from "./theme-tokens.mjs";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repoRoot = path.resolve(appRoot, "../..");
const THEME_SOURCE = path.join(repoRoot, "src/app/styles/theme.css");

/** @param {string} source */
function outputsFor(source) {
  const schemes = readSchemeColors(source);
  return [
    {
      file: path.join(appRoot, "src/theme.generated.css"),
      text: renderThemeCss(schemes),
    },
    {
      file: path.join(appRoot, "src/theme.generated.ts"),
      text: renderColorModule(schemes),
    },
  ];
}

/** @param {string} file */
async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** @param {{ file: string, text: string }[]} outputs */
async function staleFiles(outputs) {
  const stale = [];
  for (const { file, text } of outputs) {
    if ((await readIfPresent(file)) !== text)
      stale.push(path.relative(repoRoot, file));
  }
  return stale;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const outputs = outputsFor(await readFile(THEME_SOURCE, "utf8"));
  if (!checkOnly) {
    await Promise.all(outputs.map(({ file, text }) => writeFile(file, text)));
    return;
  }
  const stale = await staleFiles(outputs);
  if (stale.length > 0) {
    console.error(
      `Mobile theme is out of date with src/app/styles/theme.css: ${stale.join(", ")}.\n` +
        "Run `node apps/mobile/scripts/gen-theme.mjs` and commit the result."
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`gen-theme failed: ${error.message}`);
  process.exitCode = 1;
});
