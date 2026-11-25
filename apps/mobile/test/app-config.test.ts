/**
 * The app identity read from STATGLASS_MOBILE_* and the Expo config built
 * from it.
 */
import { expect, test } from "@jest/globals";
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
  expect(config.ios).toEqual({
    bundleIdentifier: "dev.example.glass",
    appleTeamId: "ABCDE12345",
    supportsTablet: false,
  });
  expect(config.userInterfaceStyle).toBe("automatic");
  expect(config.experiments).toEqual({ typedRoutes: true });
});
