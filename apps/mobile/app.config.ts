/**
 * Expo app config. The bundle id, Apple team, display name and build number
 * come from the environment.
 */
import type { ConfigContext, ExpoConfig } from "expo/config";
import { version } from "./package.json";

// Expo loads this config as CommonJS. Node needs the extension to load TypeScript.
const {
  themeColors,
}: typeof import("./src/theme.generated") = require("./src/theme.generated.ts");

/** Values used when the matching STATGLASS_MOBILE_* variable is unset. */
export const DEFAULT_IDENTITY = {
  bundleId: "com.tryopendata.statglass.mobile",
  teamId: "YWA9Q642YP",
  name: "StatGlass",
  buildNumber: "1",
} as const;

/** Signing, display and build identity. */
export interface AppIdentity {
  bundleId: string;
  teamId: string;
  name: string;
  buildNumber: string;
}

type Env = Readonly<Record<string, string | undefined>>;

class InvalidBuildNumberError extends Error {
  override name = "InvalidBuildNumberError";
}

function envOr(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

/** Reads the app identity from the STATGLASS_MOBILE_* variables. */
export function appIdentityFromEnv(env: Env): AppIdentity {
  const buildNumber =
    env.STATGLASS_MOBILE_BUILD_NUMBER ?? DEFAULT_IDENTITY.buildNumber;
  if (!/^0*[1-9][0-9]*$/.test(buildNumber)) {
    throw new InvalidBuildNumberError(
      "STATGLASS_MOBILE_BUILD_NUMBER must be a positive integer written with digits only."
    );
  }

  return {
    bundleId: envOr(
      env,
      "STATGLASS_MOBILE_BUNDLE_ID",
      DEFAULT_IDENTITY.bundleId
    ),
    teamId: envOr(env, "STATGLASS_MOBILE_TEAM_ID", DEFAULT_IDENTITY.teamId),
    name: envOr(env, "STATGLASS_MOBILE_NAME", DEFAULT_IDENTITY.name),
    buildNumber,
  };
}

/** Builds the Expo config for one identity on top of what Expo already resolved. */
export function expoConfigFor(
  identity: AppIdentity,
  base: Partial<ExpoConfig> = {}
): ExpoConfig {
  return {
    ...base,
    name: identity.name,
    slug: "statglass",
    scheme: "statglass",
    version,
    orientation: "portrait",
    // Light and dark follow the system setting.
    userInterfaceStyle: "automatic",
    platforms: ["ios"],
    ios: {
      bundleIdentifier: identity.bundleId,
      appleTeamId: identity.teamId,
      buildNumber: identity.buildNumber,
      supportsTablet: false,
      config: { usesNonExemptEncryption: true }, // D-158
      icon: {
        light: "./assets/icon-light.png",
        dark: "./assets/icon-dark.png",
        tinted: "./assets/icon-tinted.png",
      },
      infoPlist: {
        NSLocalNetworkUsageDescription:
          "StatGlass connects to your hosts on this network over SSH.",
      },
      // Include the reasons from CocoaPods and the Rust static library.
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyTrackingDomains: [],
        NSPrivacyCollectedDataTypes: [],
        NSPrivacyAccessedAPITypes: [
          // Rust std, bundled SQLite and React Native read file metadata.
          {
            NSPrivacyAccessedAPIType:
              "NSPrivacyAccessedAPICategoryFileTimestamp",
            NSPrivacyAccessedAPITypeReasons: ["C617.1"],
          },
          // Bundled SQLite's VFS imports statfs and fstatfs in the Rust staticlib.
          {
            NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
            NSPrivacyAccessedAPITypeReasons: ["E174.1"],
          },
          // React Native timing and Expo Device use system uptime.
          {
            NSPrivacyAccessedAPIType:
              "NSPrivacyAccessedAPICategorySystemBootTime",
            NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
          },
          // React Native and Expo Constants, Localization and System UI use defaults.
          {
            NSPrivacyAccessedAPIType:
              "NSPrivacyAccessedAPICategoryUserDefaults",
            NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
          },
        ],
      },
    },
    plugins: [
      // The generated /_sitemap screen crashes in Release (statglass:///_sitemap).
      ["expo-router", { sitemap: false }],
      "expo-status-bar",
      "expo-localization",
      [
        "expo-camera",
        {
          cameraPermission:
            "StatGlass uses the camera to scan the pairing code shown on your Mac or server.",
          microphonePermission: false,
        },
      ],
      [
        "expo-splash-screen",
        {
          image: "./assets/splash-icon.png",
          backgroundColor: themeColors.light.background,
          dark: { backgroundColor: themeColors.dark.background },
        },
      ],
      // The app lock asks for Face ID; iOS needs the reason in Info.plist.
      [
        "expo-local-authentication",
        { faceIDPermission: "StatGlass uses Face ID to unlock the app." },
      ],
    ],
    experiments: { typedRoutes: true },
  };
}

/** Expo's entry point for the config. */
export default function appConfig({ config }: ConfigContext): ExpoConfig {
  return expoConfigFor(appIdentityFromEnv(process.env), config);
}
