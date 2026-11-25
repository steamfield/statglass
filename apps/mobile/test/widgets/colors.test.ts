/**
 * Widget color tokens resolved to the generated theme values per appearance.
 */
import { expect, test } from "@jest/globals";
import { themeColors } from "@/theme.generated";
import { resolveColor } from "@/widgets/colors";

test("an ink accent differs between light and dark", () => {
  const ink = { kind: "accent", accent: "cpu", step: 1, ink: true } as const;

  expect(resolveColor(ink, "light")).toBe(themeColors.light["cpu-ink"]);
  expect(resolveColor(ink, "dark")).toBe(themeColors.dark["cpu-ink"]);
  expect(resolveColor(ink, "light")).not.toBe(resolveColor(ink, "dark"));
});

test("ramp steps fade the accent in scope", () => {
  const step = (s: 1 | 2 | 3 | 4) =>
    resolveColor({ kind: "accent", step: s, ink: false }, "dark", "mem");

  expect([step(1), step(2), step(3), step(4)]).toEqual([
    "#a78bfa",
    "#a78bfa99",
    "#a78bfa59",
    "#a78bfa33",
  ]);
});

test("named tokens map onto the theme's names", () => {
  expect(resolveColor({ kind: "token", name: "fg-muted" }, "light")).toBe(
    themeColors.light["muted-foreground"]
  );
  expect(resolveColor({ kind: "token", name: "track" }, "dark")).toBe(
    themeColors.dark.track
  );
});

test("a desktop css color falls back to the accent in scope", () => {
  expect(
    resolveColor({ kind: "css", value: "color-mix(…)" }, "dark", "gpu")
  ).toBe(themeColors.dark.gpu);
});

test("an accent color with no accent in scope says how to fix it", () => {
  expect(() =>
    resolveColor({ kind: "accent", step: 1, ink: false }, "dark")
  ).toThrow("pass the widget's accent as accentInScope");
});
