import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@jest/globals";

const root = resolve(__dirname, "../..");
const forbidden = ["UIBackgroundModes", "BGTaskSchedulerPermittedIdentifiers"];

test("Expo and its plugins leave iOS background modes and scheduled tasks unset", () => {
  const output = execFileSync(
    process.execPath,
    [
      require.resolve("expo/bin/cli"),
      "config",
      "--type",
      "introspect",
      "--json",
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } }
  );
  const config = JSON.parse(output);
  expect(config._internal.modResults.ios.infoPlist).toBeDefined();
  for (const key of forbidden) {
    expect(config.ios.infoPlist).not.toHaveProperty(key);
    expect(config._internal.modResults.ios.infoPlist).not.toHaveProperty(key);
  }

  const ios = join(root, "ios");
  if (existsSync(ios)) {
    const plists = readdirSync(ios)
      .map((directory) => join(ios, directory, "Info.plist"))
      .filter(existsSync);
    expect(plists.length).toBeGreaterThan(0);
    for (const plist of plists) {
      for (const key of forbidden) {
        expect(readFileSync(plist, "utf8")).not.toContain(`<key>${key}</key>`);
      }
    }
  }
});
