import { expect, it } from "@jest/globals";
import { mobileSources, openingTags } from "@test/helpers/source-scan";

const SURFACES = [
  "View",
  "Pressable",
  "Animated.View",
  "AnimatedPressable",
] as const;

/** `file: detail` for every opening tag of a surface element that `matches`. */
function surfaceTags(
  allowed: readonly string[],
  matches: (tag: string) => boolean
): string[] {
  return mobileSources()
    .filter(({ file }) => !allowed.includes(file))
    .flatMap(({ file, source }) =>
      openingTags(source, SURFACES)
        .filter(matches)
        .map((tag) => `${file}: ${tag.replace(/\s+/g, " ").slice(0, 120)}`)
    );
}

it("writes the 44 pt touch target as the touch token", () => {
  const violations = mobileSources()
    .filter(({ source }) => source.includes("[44px]"))
    .map(({ file }) => file);

  expect(violations).toEqual([]);
});

it("draws the card surface only through Card", () => {
  const violations = surfaceTags(["ui/card.tsx", "ui/button.tsx"], (tag) =>
    ["rounded-xl", "border-border", "bg-card"].every((name) =>
      new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(tag)
    )
  );

  expect(violations).toEqual([]);
});

it("draws a filled button only through Button", () => {
  const violations = surfaceTags(
    ["ui/button.tsx"],
    (tag) =>
      /(?<![\w-])rounded-(?:lg|xl)(?![\w-])/.test(tag) &&
      /(?<![\w-])bg-primary(?![\w-])/.test(tag)
  );

  expect(violations).toEqual([]);
});

it("has no PairAction or CARD_SURFACE left", () => {
  const violations = mobileSources()
    .filter(({ source }) => /\b(?:PairAction|CARD_SURFACE)\b/.test(source))
    .map(({ file }) => file);

  expect(violations).toEqual([]);
});
