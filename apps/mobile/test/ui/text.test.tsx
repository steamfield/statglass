import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "@jest/globals";
import { mobileSources, openingTags } from "@test/helpers/source-scan";
import { render } from "@testing-library/react-native";
import { Text, type TextTone, type TextVariant } from "@/ui/text";

const TONE_CLASSES = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  subtle: "text-fg-subtle",
  faint: "text-fg-faint",
  link: "text-link",
  destructive: "text-destructive",
  warning: "text-warning-ink",
  onPrimary: "text-primary-foreground",
} satisfies Record<TextTone, string>;

const COLOUR_CLASSES: readonly string[] = Object.values(TONE_CLASSES);

/** The classes a rendered Text carries, in order. */
function classesOf(element: { props: { className?: unknown } }): string[] {
  return String(element.props.className ?? "")
    .split(/\s+/)
    .filter(Boolean);
}

/** The theme colour classes among them. A Text must carry exactly one. */
function coloursOf(element: { props: { className?: unknown } }): string[] {
  return classesOf(element).filter((name) => COLOUR_CLASSES.includes(name));
}

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
    expect(classesOf(text)).toEqual([
      ["label", "caption", "axis"].includes(variant)
        ? "text-muted-foreground"
        : "text-foreground",
    ]);
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

it.each(
  (Object.entries(TONE_CLASSES) as [TextTone, string][]).flatMap(
    ([tone, colour]) =>
      (["caption", "body"] as const).map(
        (variant) => [tone, variant, colour] as const
      )
  )
)("renders the %s tone on %s as only %s", async (tone, variant, colour) => {
  const view = await render(
    <Text variant={variant} tone={tone}>
      reading
    </Text>
  );

  expect(coloursOf(view.getByText("reading"))).toEqual([colour]);
});

it("keeps the caller's layout classes after the tone class", async () => {
  const view = await render(
    <Text variant="label" tone="link" className="shrink text-right">
      Clear pin
    </Text>
  );

  expect(classesOf(view.getByText("Clear pin"))).toEqual([
    "text-link",
    "shrink",
    "text-right",
  ]);
});

it.each([
  ["body", "semibold", "600"],
  ["cardTitle", "regular", "400"],
] as const)(
  "renders %s at %s weight without a weight class",
  async (variant, weight, fontWeight) => {
    const view = await render(
      <Text variant={variant} weight={weight}>
        Retry
      </Text>
    );

    const text = view.getByText("Retry");
    expect(text).toHaveStyle({ fontWeight });
    expect(classesOf(text).filter((name) => name.startsWith("font-"))).toEqual(
      []
    );
  }
);

it("lets the caller's style override the weight", async () => {
  const view = await render(
    <Text variant="body" weight="semibold" style={{ fontWeight: "700" }}>
      Retry
    </Text>
  );

  expect(view.getByText("Retry")).toHaveStyle({ fontWeight: "700" });
});

it("gives a proportional variant tabular numerals when asked", async () => {
  const view = await render(
    <>
      <Text variant="caption" tabular>
        42 %
      </Text>
      <Text variant="caption">Idle</Text>
      <Text variant="cardFigure" tabular>
        3.2 GHz
      </Text>
    </>
  );

  expect(view.getByText("42 %")).toHaveStyle({ fontVariant: ["tabular-nums"] });
  expect(view.getByText("Idle")).not.toHaveStyle({
    fontVariant: ["tabular-nums"],
  });
  expect(view.getByText("3.2 GHz")).toHaveStyle({
    fontVariant: ["tabular-nums"],
    fontFamily: "ui-rounded",
  });
});

it("passes no colour, weight or numeral class to a Text in mobile source", () => {
  const owned =
    /\btext-(?:foreground|muted-foreground|fg-subtle|fg-faint|link|destructive|warning-ink|primary-foreground)(?![\w-])|\bfont-(?:thin|light|normal|medium|semibold|bold|extrabold|black)(?![\w-])|\btabular-nums(?![\w-])/g;
  const violations = mobileSources().flatMap(({ file, source }) =>
    openingTags(source, ["Text"]).flatMap((tag) =>
      (tag.match(owned) ?? []).map((name) => `${file}: ${name}`)
    )
  );

  expect(violations).toEqual([]);
});

it("uses no important modifier on a class in mobile source", () => {
  const important =
    /(?<=["'`\s])(?:[a-z][\w:./[\]]*-[\w[\]./-]*!|![a-z][\w:]*-[\w-]+)(?=["'`\s])/g;
  const violations = mobileSources().flatMap(({ file, source }) =>
    (source.match(important) ?? []).map((name) => `${file}: ${name}`)
  );

  expect(violations).toEqual([]);
});

it("contains no Text role props or role spreads in mobile source", () => {
  const src = resolve(__dirname, "../../src");
  const role = /<Text(?=\s)[^>]*\srole\s*=/;
  const spread = /\{\s*\.\.\.\s*\{\s*role\s*:/;
  const violations = readdirSync(src, { encoding: "utf8", recursive: true })
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => {
      const source = readFileSync(join(src, file), "utf8");
      return role.test(source) || spread.test(source);
    });

  expect(violations).toEqual([]);
});
