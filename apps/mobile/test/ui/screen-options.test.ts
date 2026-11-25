import { expect, test } from "@jest/globals";
import { screenOptions } from "@/ui/screen-options";
import { colorsForScheme } from "@/ui/theme-colors";

// Info.plist makes status bar appearance view-controller based, so each
// screen's options decide it; an app-level appearance override must reach them.
test.each([
  ["light", "dark"],
  ["dark", "light"],
] as const)("a %s appearance gets a %s status bar", (scheme, barStyle) => {
  expect(screenOptions(colorsForScheme(scheme)).statusBarStyle).toBe(barStyle);
});
