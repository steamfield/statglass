import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/*
 * Theme values live in theme.css (styling.md), so a re-theme never edits
 * components. These classes bypass the scale. Some would also fail silently:
 * the stock radius scale is cleared (square corners, no error) and the
 * `.lucide` rule overrides a `strokeWidth` prop.
 */
const BANNED: { pattern: RegExp; use: string }[] = [
  // `text-[0px]` hides text (the sidebar's collapsed badge); it is not a size.
  { pattern: /\btext-\[(?!0px\])\d+(\.\d+)?px\]/, use: "a --text-* token" },
  {
    pattern: /(?<![-\w])text-(xs|sm|base|lg|xl|[2-9]xl)\b/,
    use: "a --text-* token",
  },
  { pattern: /\bfont-\[\d+\]/, use: "font-medium, font-semibold or a token" },
  { pattern: /\btracking-\[/, use: "a --tracking-* token" },
  {
    pattern: /\brounded(-[trblse]{1,2})?-(xs|sm|md|lg|xl|[2-4]xl)\b/,
    use: "a --radius-* token",
  },
  { pattern: /\brounded(-[trblse]{1,2})?-\[\d/, use: "a --radius-* token" },
  {
    pattern: /<[A-Z]\w*\b[^<>]*?\sstrokeWidth=/,
    use: "icon-light, icon-regular or icon-bold",
  },
];

const root = resolve(process.cwd(), "src/app");
const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
  (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)
);

describe("theme usage", () => {
  it("scans the app source", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("keeps theme values out of components", () => {
    const hits: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      for (const { pattern, use } of BANNED) {
        const match = pattern.exec(source);
        if (!match) continue;
        const line = source.slice(0, match.index).split("\n").length;
        hits.push(`src/app/${file}:${line} "${match[0]}": use ${use}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
