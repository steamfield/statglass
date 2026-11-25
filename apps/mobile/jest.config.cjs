/**
 * Jest config: jest-expo on Node, with the `@core/*` alias mapped to the shared
 * package, `@/*` to the app's src/, `@native/*` to its local Expo modules and
 * `@test/*` to test/, React and React Native pinned to the copies the app resolves (the
 * same rule as metro-resolve.cjs), and the untranspiled packages added to the
 * preset's transform allowlist.
 */
const path = require("node:path");
const preset = require("jest-expo/jest-preset");

/**
 * Extra packages that ship untranspiled or ESM-only source and must go through
 * Babel. d3 and internmap come in through packages/core (d3-hierarchy).
 */
const TRANSPILED_PACKAGES = [
  "nativewind",
  "react-native-css",
  "d3-[^/]+",
  "internmap",
];

/** Packages that must load from the app's own install, as in Metro. */
const PINNED_PACKAGES = ["react", "react-native"];

/** The preset's catch-all entry for react-native and its subpaths. */
const NATIVE_PATTERN = "^react-native($|/.*)";

// Formatters and clocks in tests read the same zone everywhere.
process.env.TZ = "UTC";

/** @param {string} name */
function appPackageDir(name) {
  return path.dirname(
    require.resolve(`${name}/package.json`, { paths: [__dirname] })
  );
}

/** `^name($|/.*)` maps the package and its subpaths to the app's copy. */
function pinnedMappings() {
  return Object.fromEntries(
    PINNED_PACKAGES.map((name) => [
      `^${name}($|/.*)`,
      `${appPackageDir(name)}$1`,
    ])
  );
}

/**
 * The preset's mappings with any path into its React Native copy moved to the
 * app's copy, so its specific entries (asset registry, setup) stay consistent
 * with the pin. Its own generic react-native entry is replaced by the pin.
 * @throws {Error} when the preset no longer maps react-native the way this reads
 */
function presetMappings() {
  const generic = preset.moduleNameMapper[NATIVE_PATTERN];
  if (!generic?.endsWith("/$1")) {
    throw new Error(
      `jest-expo's preset maps ${NATIVE_PATTERN} to ${generic}; expected "<dir>/$1". Update presetMappings in apps/mobile/jest.config.cjs.`
    );
  }
  const presetNativeDir = generic.slice(0, -"/$1".length);
  const appNativeDir = appPackageDir("react-native");
  return Object.fromEntries(
    Object.entries(preset.moduleNameMapper).map(([pattern, target]) => [
      pattern,
      target.startsWith(presetNativeDir)
        ? appNativeDir + target.slice(presetNativeDir.length)
        : target,
    ])
  );
}

module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
  testMatch: [
    "<rootDir>/test/**/*.test.{ts,tsx}",
    "<rootDir>/src/**/*.test.{ts,tsx}",
  ],
  moduleNameMapper: {
    "^@core/(.*)$": "<rootDir>/../../packages/core/src/$1",
    // Before the app alias, so `@/global.css` still loads the stub.
    "\\.css$": "<rootDir>/test/css-stub.ts",
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@native/(.*)$": "<rootDir>/modules/$1",
    // Test helpers, so tests in subdirectories reach them without `../`.
    "^@test/(.*)$": "<rootDir>/test/$1",
    // The bundled Reanimated mock loads the native runtime and throws under
    // jest-expo; expo-router's testing library requires it, so send it to the stub.
    "^react-native-reanimated/mock$": "<rootDir>/test/reanimated-stub.ts",
    ...presetMappings(),
    ...pinnedMappings(),
  },
  transformIgnorePatterns: preset.transformIgnorePatterns.map((pattern) =>
    pattern.replace("(?!(", `(?!(${TRANSPILED_PACKAGES.join("|")}|`)
  ),
  testTimeout: 15000,
};
