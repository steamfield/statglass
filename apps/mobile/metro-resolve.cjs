/**
 * Metro module resolution for the workspace: maps the `@core/*` alias to
 * packages/core/src and resolves React and React Native as the mobile app
 * itself would, so a shared package never pulls in the desktop's copy.
 */
const path = require("node:path");

const CORE_ALIAS = "@core/";

/** Packages that must resolve from apps/mobile, however deep the importer is. */
const PINNED_PACKAGES = ["react", "react-native"];

/**
 * Whether `moduleName` is one of the pinned packages or a subpath of one.
 * @param {string} moduleName
 */
function isPinned(moduleName) {
  return PINNED_PACKAGES.some(
    (name) => moduleName === name || moduleName.startsWith(`${name}/`)
  );
}

/**
 * Builds a Metro `resolveRequest` for an app at `appRoot` whose shared core
 * source lives at `coreSrc`.
 * @param {{ appRoot: string, coreSrc: string }} roots
 * @returns {(context: any, moduleName: string, platform: string | null) => any}
 */
function createResolveRequest({ appRoot, coreSrc }) {
  // Resolving "as if imported from the app's package.json" finds the copy in
  // apps/mobile/node_modules when Bun nested one there, and the hoisted copy
  // only when the versions match. extraNodeModules would only be a fallback.
  const appOrigin = path.join(appRoot, "package.json");

  return function resolveRequest(context, moduleName, platform) {
    if (moduleName.startsWith(CORE_ALIAS)) {
      const target = path.join(coreSrc, moduleName.slice(CORE_ALIAS.length));
      return context.resolveRequest(context, target, platform);
    }
    if (isPinned(moduleName)) {
      const fromApp = { ...context, originModulePath: appOrigin };
      return context.resolveRequest(fromApp, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
  };
}

module.exports = { createResolveRequest, isPinned };
