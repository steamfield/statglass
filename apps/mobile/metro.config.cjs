/**
 * Metro config: Expo's defaults, the workspace's shared packages as a watch
 * folder, the workspace resolver and NativeWind.
 */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativewind } = require("nativewind/metro");
const { createResolveRequest } = require("./metro-resolve.cjs");

const appRoot = __dirname;
const packagesRoot = path.resolve(appRoot, "../../packages");

const defaults = getDefaultConfig(appRoot);

module.exports = withNativewind({
  ...defaults,
  watchFolders: [...(defaults.watchFolders ?? []), packagesRoot],
  resolver: {
    ...defaults.resolver,
    resolveRequest: createResolveRequest({
      appRoot,
      coreSrc: path.join(packagesRoot, "core/src"),
    }),
  },
});
