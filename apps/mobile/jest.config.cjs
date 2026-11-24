/**
 * Jest config: jest-expo on Node, with the `@core/*` alias mapped to the shared
 * package and NativeWind's packages added to the preset's transform allowlist.
 */
const preset = require("jest-expo/jest-preset");

// Extra packages that ship untranspiled source and must go through Babel.
const TRANSPILED_PACKAGES = ["nativewind", "react-native-css"];

// Formatters and clocks in tests read the same zone everywhere.
process.env.TZ = "UTC";

module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
  testMatch: ["<rootDir>/test/**/*.test.ts", "<rootDir>/test/**/*.test.tsx"],
  moduleNameMapper: {
    "^@core/(.*)$": "<rootDir>/../../packages/core/src/$1",
    "\\.css$": "<rootDir>/test/css-stub.ts",
  },
  transformIgnorePatterns: preset.transformIgnorePatterns.map((pattern) =>
    pattern.replace("(?!(", `(?!(${TRANSPILED_PACKAGES.join("|")}|`)
  ),
  testTimeout: 15000,
};
