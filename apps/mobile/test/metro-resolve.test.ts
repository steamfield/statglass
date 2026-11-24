/**
 * The workspace resolver Metro uses: `@core/*` goes to the shared package's
 * source and React resolves from the app, wherever the import comes from.
 * Metro's own resolver is stood in by one that reports which directory it
 * resolved from, since that decides which installed copy a bundle gets.
 */

import path from "node:path";
import { expect, test } from "@jest/globals";
import { createResolveRequest } from "../metro-resolve.cjs";

const appRoot = path.resolve(__dirname, "..");
const coreSrc = path.resolve(appRoot, "../../packages/core/src");
const coreFile = path.join(coreSrc, "live-state.ts");

interface Resolution {
  type: "sourceFile";
  filePath: string;
  fromDir: string;
}

interface MetroContext {
  originModulePath: string;
  resolveRequest: (
    context: MetroContext,
    moduleName: string,
    platform: string | null
  ) => Resolution;
}

const metroContext: MetroContext = {
  originModulePath: coreFile,
  resolveRequest: (context, moduleName) => ({
    type: "sourceFile",
    filePath: moduleName,
    fromDir: path.dirname(context.originModulePath),
  }),
};

const resolve = createResolveRequest({ appRoot, coreSrc });

test("maps @core/<path> to packages/core/src/<path>", () => {
  const resolved = resolve(metroContext, "@core/format", "ios");

  expect(resolved.filePath).toBe(path.join(coreSrc, "format"));
});

test.each([
  "react",
  "react/jsx-runtime",
  "react-native",
  "react-native/Libraries/Core/InitializeCore",
])(
  "resolves %s from apps/mobile even when a shared package imports it",
  (moduleName) => {
    const resolved = resolve(metroContext, moduleName, "ios");

    expect(resolved).toEqual({
      type: "sourceFile",
      filePath: moduleName,
      fromDir: appRoot,
    });
  }
);

test.each(["react-native-svg", "react-dom", "d3-hierarchy"])(
  "leaves %s to resolve from the importing file",
  (moduleName) => {
    const resolved = resolve(metroContext, moduleName, "ios");

    expect(resolved.fromDir).toBe(path.dirname(coreFile));
  }
);
