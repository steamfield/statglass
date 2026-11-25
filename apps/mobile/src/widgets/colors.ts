/**
 * Resolves a widget model's color token to a concrete color for one
 * appearance, from the theme values generated off the desktop's theme.
 */
import type { Accent, ColorRef } from "@core/widget-models/tokens";
import { themeColors } from "@/theme.generated";

type Scheme = "light" | "dark";
type ThemeToken = keyof (typeof themeColors)["light"];

/** The ramp's opacity per step (the desktop's `--ramp-*`). */
const RAMP_ALPHA: Record<1 | 2 | 3 | 4, number> = {
  1: 1,
  2: 0.6,
  3: 0.35,
  4: 0.2,
};

/** Model token names that the theme spells differently. */
const TOKEN_NAME: Record<
  Extract<ColorRef, { kind: "token" }>["name"],
  ThemeToken
> = {
  track: "track",
  "fg-faint": "fg-faint",
  "fg-muted": "muted-foreground",
};

/**
 * `hex` (#rgb, #rrggbb or #rrggbbaa) with its alpha multiplied by `alpha`,
 * as #rrggbbaa.
 * @throws {Error} for a color that is not a hex value
 */
function withAlpha(hex: string, alpha: number): string {
  if (alpha === 1) return hex;
  const digits = hex.slice(1);
  const full =
    digits.length === 3
      ? [...digits].map((d) => d + d).join("")
      : digits.slice(0, 6);
  if (!/^#[0-9a-f]+$/i.test(hex) || full.length !== 6) {
    throw new Error(
      `withAlpha: "${hex}" is not a #rgb, #rrggbb or #rrggbbaa color; regenerate the theme with apps/mobile/scripts/gen-theme.mjs.`
    );
  }
  const base = digits.length === 8 ? Number.parseInt(digits.slice(6), 16) : 255;
  const a = Math.round(base * alpha)
    .toString(16)
    .padStart(2, "0");
  return `#${full}${a}`;
}

function accentOf(
  ref: { accent?: Accent },
  accentInScope: Accent | undefined
): Accent {
  const accent = ref.accent ?? accentInScope;
  if (accent === undefined) {
    throw new Error(
      "resolveColor: the color names no accent and none is in scope; pass the widget's accent as accentInScope."
    );
  }
  return accent;
}

/**
 * The color `ref` names in `scheme`. An accent without its own accent takes
 * `accentInScope`. A hatch resolves to its accent's fill (the renderer draws
 * the stripes). A `css` color is a desktop-only value (frequency residency),
 * so the phone draws the accent in scope instead.
 * @throws {Error} when an accent color has no accent and none is in scope
 */
export function resolveColor(
  ref: ColorRef,
  scheme: Scheme,
  accentInScope?: Accent
): string {
  const colors = themeColors[scheme];
  switch (ref.kind) {
    case "accent": {
      const accent = accentOf(ref, accentInScope);
      const base = ref.ink ? colors[`${accent}-ink`] : colors[accent];
      return withAlpha(base, RAMP_ALPHA[ref.step]);
    }
    case "hatch":
      return colors[accentOf(ref, accentInScope)];
    case "token":
      return colors[TOKEN_NAME[ref.name]];
    case "css":
      return colors[accentOf({}, accentInScope)];
  }
}
