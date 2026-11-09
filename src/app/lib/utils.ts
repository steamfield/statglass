import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's stock theme. Without these, a custom
 * size such as `text-label` reads as a text color and `cn()` drops it (or the
 * color) when both appear. utils.test.ts fails when a `@theme` token in
 * styles/theme.css is missing here.
 */
const twMerge = extendTailwindMerge<"icon-stroke">({
  extend: {
    classGroups: {
      "icon-stroke": [{ icon: ["light", "regular", "bold"] }],
    },
    theme: {
      text: [
        "micro",
        "caption",
        "label",
        "small",
        "body",
        "heading",
        "figure",
        "figure-lg",
        "title-sm",
        "title",
        "title-lg",
        "page-title",
        "display",
        "hero",
        "tray-label",
        "tray-value",
        "tray-glyph",
      ],
      "font-weight": ["wordmark"],
      tracking: ["title", "figure", "snug"],
      leading: ["compact"],
      radius: ["panel", "card", "tile", "control", "chip", "mark", "hair"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
