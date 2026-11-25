/**
 * Color tokens the widget models speak in. A model never returns a CSS
 * string or a hex value: it names a token, and each app resolves the token
 * its own way (the desktop through CSS custom properties, the phone through
 * the shared theme values).
 */

/**
 * Module accent tokens (design-system.md "Module accents"). Each maps to a
 * fill color and an `-ink` color for lines, text and thin marks (darker in
 * light mode).
 */
export type Accent =
  | "cpu"
  | "cpu-2"
  | "gpu"
  | "mem"
  | "power"
  | "temp"
  | "net"
  | "disk"
  | "battery";

/** Ramp step of the accent: 100%, 60%, 35%, 20%, or a diagonal hatch. */
export type RampStep = 1 | 2 | 3 | 4 | "hatch";

/** A ramp step, the empty track (a "free" remainder), or no swatch at all. */
export type SwatchStep = RampStep | "track" | "none";

/**
 * A color by token: the accent in scope when `accent` is absent; `ink` for
 * lines and text. `css` carries a `StackBarSegment.color` (frequency
 * residency) through unchanged; the phone twins ignore it.
 */
export type ColorRef =
  | { kind: "accent"; accent?: Accent; step: 1 | 2 | 3 | 4; ink: boolean }
  | { kind: "hatch"; accent?: Accent }
  | { kind: "token"; name: "track" | "fg-faint" | "fg-muted" }
  | { kind: "css"; value: string };
