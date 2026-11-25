/**
 * The app identity read from STATGLASS_MOBILE_* and the Expo config built
 * from it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "@jest/globals";
import type { ExpoConfig } from "expo/config";
import { themeColors } from "@/theme.generated";
import {
  appIdentityFromEnv,
  DEFAULT_IDENTITY,
  expoConfigFor,
} from "../app.config";

test("uses the StatGlass defaults when no variable is set", () => {
  expect(appIdentityFromEnv({})).toEqual(DEFAULT_IDENTITY);
});

test("treats empty and blank variables as unset", () => {
  const env = {
    STATGLASS_MOBILE_BUNDLE_ID: "",
    STATGLASS_MOBILE_TEAM_ID: "  ",
    STATGLASS_MOBILE_NAME: "",
  };

  expect(appIdentityFromEnv(env)).toEqual(DEFAULT_IDENTITY);
});

test("puts the identity from the environment into the iOS config", () => {
  const identity = appIdentityFromEnv({
    STATGLASS_MOBILE_BUNDLE_ID: "dev.example.glass",
    STATGLASS_MOBILE_TEAM_ID: "ABCDE12345",
    STATGLASS_MOBILE_NAME: "Glass Dev",
  });

  const config = expoConfigFor(identity);

  expect(config.name).toBe("Glass Dev");
  expect(config.ios).toMatchObject({
    bundleIdentifier: "dev.example.glass",
    appleTeamId: "ABCDE12345",
  });
  expect(config.userInterfaceStyle).toBe("automatic");
  expect(config.experiments).toEqual({ typedRoutes: true });
});

test("derives the release metadata and iPhone settings from the package and identity", () => {
  const packageJson: { version: string } = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8")
  );
  const config = expoConfigFor(
    appIdentityFromEnv({ STATGLASS_MOBILE_BUILD_NUMBER: "1234" }),
    {
      version: "0.0.0",
      orientation: "landscape",
      ios: { supportsTablet: true },
    }
  );

  expect(config.version).toBe(packageJson.version);
  expect(config.orientation).toBe("portrait");
  expect(config.ios).toMatchObject({
    buildNumber: "1234",
    supportsTablet: false,
    config: { usesNonExemptEncryption: true },
  });
});

test("defaults the iOS build number to 1 when the variable is absent", () => {
  const config = expoConfigFor(appIdentityFromEnv({}));

  expect(config.ios?.buildNumber).toBe("1");
});

test.each(["abc", "", " ", "0", "-1", "1.5", "1e3"])(
  "rejects invalid STATGLASS_MOBILE_BUILD_NUMBER %j with a named error",
  (value) => {
    expect(() =>
      appIdentityFromEnv({ STATGLASS_MOBILE_BUILD_NUMBER: value })
    ).toThrow(
      expect.objectContaining({
        name: "InvalidBuildNumberError",
        message: expect.stringContaining("STATGLASS_MOBILE_BUILD_NUMBER"),
      })
    );
  }
);

test("declares no tracking or collection and includes the audited privacy reasons", () => {
  const manifest = expoConfigFor(appIdentityFromEnv({})).ios?.privacyManifests;

  expect(manifest).toEqual({
    NSPrivacyTracking: false,
    NSPrivacyTrackingDomains: [],
    NSPrivacyCollectedDataTypes: [],
    NSPrivacyAccessedAPITypes: expect.arrayContaining([
      {
        NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
        NSPrivacyAccessedAPITypeReasons: ["C617.1"],
      },
      {
        NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
        NSPrivacyAccessedAPITypeReasons: ["E174.1"],
      },
      {
        NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
        NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
      },
      {
        NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
        NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
      },
    ]),
  });
  expect(manifest?.NSPrivacyAccessedAPITypes).toHaveLength(4);
});

test("uses the three StatGlass icon variants", () => {
  const config = expoConfigFor(appIdentityFromEnv({}));

  expect(config.ios?.icon).toEqual({
    light: "./assets/icon-light.png",
    dark: "./assets/icon-dark.png",
    tinted: "./assets/icon-tinted.png",
  });
});

describe("Expo iOS config", () => {
  let config: ExpoConfig & {
    _internal: { modResults: { ios: { infoPlist: Record<string, unknown> } } };
  };

  beforeAll(() => {
    config = JSON.parse(
      execFileSync(
        process.execPath,
        [
          require.resolve("expo/bin/cli"),
          "config",
          "--type",
          "introspect",
          "--json",
        ],
        {
          cwd: join(__dirname, ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            EXPO_NO_DOTENV: "1",
            STATGLASS_MOBILE_BUILD_NUMBER: "1",
          },
        }
      )
    );
  });

  test("writes specific purpose strings for Local Network, camera and Face ID", () => {
    const { infoPlist } = config._internal.modResults.ios;

    expect(infoPlist).toMatchObject({
      NSLocalNetworkUsageDescription:
        "StatGlass connects to your hosts on this network over SSH.",
      NSCameraUsageDescription:
        "StatGlass uses the camera to scan the pairing code shown on your Mac or server.",
      NSFaceIDUsageDescription: "StatGlass uses Face ID to unlock the app.",
    });
    expect(infoPlist).not.toHaveProperty("NSBonjourServices");
    expect(infoPlist).not.toHaveProperty("NSMicrophoneUsageDescription");
    expect(config.plugins).toContainEqual([
      "expo-camera",
      expect.objectContaining({ microphonePermission: false }),
    ]);
  });

  test("resolves the launch screen image and theme backgrounds", () => {
    expect(config.plugins).toContainEqual([
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        backgroundColor: themeColors.light.background,
        dark: { backgroundColor: themeColors.dark.background },
      },
    ]);
  });
});
