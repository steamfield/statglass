/** Pins the touch target and spacing scale in the compiled native stylesheet. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const mobileRoot = fileURLToPath(new URL("..", import.meta.url));
const requireFromMobile = createRequire(join(mobileRoot, "package.json"));
const postcss = requireFromMobile("postcss");
const tailwind = requireFromMobile("@tailwindcss/postcss");
const compilerUrl = new URL(
  "./node/compiler.mjs",
  pathToFileURL(requireFromMobile.resolve("react-native-css/package.json"))
);
/** @type {typeof import("react-native-css/compiler")} */
const { compile } = await import(compilerUrl.href);

/** Loads the native transformer's actual compiler options from the app's Metro config. */
function readMetroCompilerOptions() {
  // NativeWind resolves its TypeScript environment relative to the working directory.
  const previousDirectory = process.cwd();
  process.chdir(mobileRoot);
  try {
    return requireFromMobile("./metro.config.cjs").transformer.reactNativeCSS;
  } finally {
    process.chdir(previousDirectory);
  }
}

/**
 * Reads the native style declarations registered for a utility class.
 * @param {import("react-native-css/compiler").ReactNativeCssStyleSheet} stylesheet
 * @param {string} className
 */
function classDeclarations(stylesheet, className) {
  return stylesheet.s
    ?.find(([name]) => name === className)?.[1]
    .flatMap(({ d }) => d ?? []);
}

test("compiles min-h-touch to 44 pt and px-4 to 14 pt", async () => {
  const filename = join(mobileRoot, "src/global.css");
  const source = await readFile(filename, "utf8");
  const { css } = await postcss([tailwind({ base: mobileRoot })]).process(
    `${source}\n@source inline("min-h-touch px-4");`,
    { from: filename }
  );
  const stylesheet = compile(css, {
    ...readMetroCompilerOptions(),
    filename,
    projectRoot: mobileRoot,
  }).stylesheet();

  assert.deepEqual(classDeclarations(stylesheet, "min-h-touch"), [
    { minHeight: 44 },
  ]);
  assert.deepEqual(classDeclarations(stylesheet, "px-4"), [
    { paddingInline: 14 },
  ]);
});
