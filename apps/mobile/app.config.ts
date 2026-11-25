/**
 * Expo app config. The bundle id, Apple team and display name come from the
 * environment so a fork or a second signing team can build without editing
 * this file; everything else is fixed here.
 */
import type { ConfigContext, ExpoConfig } from "expo/config";

/** Values used when the matching STATGLASS_MOBILE_* variable is unset or empty. */
export const DEFAULT_IDENTITY = {
  bundleId: "com.tryopendata.statglass.mobile",
  teamId: "YWA9Q642YP",
  name: "StatGlass",
} as const;

/** Who the app is signed and shown as. */
export interface AppIdentity {
  bundleId: string;
  teamId: string;
  name: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function envOr(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

/** Reads the app identity from STATGLASS_MOBILE_BUNDLE_ID, _TEAM_ID and _NAME. */
export function appIdentityFromEnv(env: Env): AppIdentity {
  return {
    bundleId: envOr(
      env,
      "STATGLASS_MOBILE_BUNDLE_ID",
      DEFAULT_IDENTITY.bundleId
    ),
    teamId: envOr(env, "STATGLASS_MOBILE_TEAM_ID", DEFAULT_IDENTITY.teamId),
    name: envOr(env, "STATGLASS_MOBILE_NAME", DEFAULT_IDENTITY.name),
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
    // Light and dark follow the system setting.
    userInterfaceStyle: "automatic",
    platforms: ["ios"],
    ios: {
      bundleIdentifier: identity.bundleId,
      appleTeamId: identity.teamId,
      supportsTablet: false,
    },
    plugins: [
      "expo-router",
      "expo-status-bar",
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
