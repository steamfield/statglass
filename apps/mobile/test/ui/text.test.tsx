import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { Text, type TextVariant } from "@/ui/text";

const variants = {
  largeTitle: [34, "600", "header"],
  title: [22, "600", "header"],
  onboardingTitle: [28, "600", "header"],
  cardTitle: [13, "600"],
  cardFigure: [15, "600"],
  heroFigure: [28, "600"],
  body: [17, "400"],
  label: [13, "400"],
  value: [13, "400"],
  caption: [12, "400"],
  axis: [11, "400"],
} satisfies Record<TextVariant, readonly [number, "400" | "600", "header"?]>;

it.each(Object.entries(variants))(
  "renders the %s typography and accessibility defaults",
  async (name, [fontSize, fontWeight, accessibilityRole]) => {
    const variant = name as TextVariant;
    const view = await render(<Text variant={variant}>{variant}</Text>);
    const text = view.getByText(variant);
    const rounded = variant === "cardFigure" || variant === "heroFigure";
    const tabular = rounded || variant === "axis" || variant === "value";
    expect(text).toHaveStyle({
      fontSize,
      fontWeight,
      fontFamily: rounded ? "ui-rounded" : undefined,
      fontVariant: tabular ? ["tabular-nums"] : undefined,
    });
    expect(text).toHaveProp(
      "className",
      expect.stringContaining(
        ["label", "caption", "axis"].includes(variant)
          ? "text-muted-foreground"
          : "text-foreground"
      )
    );
    if (variant === "axis") {
      expect(text).toHaveProp("maxFontSizeMultiplier", 1.5);
    } else {
      expect(text).not.toHaveProp("maxFontSizeMultiplier");
    }
    expect(view.queryByRole("header", { name: variant })).toBe(
      accessibilityRole ? text : null
    );
  }
);

it("accepts the phase 9 role alias and prefers variant when both are supplied", async () => {
  const view = await render(
    <>
      <Text role="title">Alias only</Text>
      <Text variant="body" role="title">
        Both props
      </Text>
    </>
  );

  expect(view.getByRole("header", { name: "Alias only" })).toHaveStyle({
    fontSize: 22,
  });
  expect(view.getByText("Both props")).toHaveStyle({ fontSize: 17 });
  expect(view.queryByRole("header", { name: "Both props" })).toBeNull();
});

it("contains no Text role spreads in mobile source", () => {
  const src = resolve(__dirname, "../../src");
  const spread = /\{\s*\.\.\.\s*\{\s*role\s*:/;
  const violations = readdirSync(src, { encoding: "utf8", recursive: true })
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => spread.test(readFileSync(join(src, file), "utf8")));

  expect(violations).toEqual([]);
});
