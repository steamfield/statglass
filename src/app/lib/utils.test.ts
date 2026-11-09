import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cn } from "~/lib/utils";

// Vitest stubs CSS imports (even `?raw`), so read the file from the repo root.
const themeCss = readFileSync(
  resolve(process.cwd(), "src/app/styles/theme.css"),
  "utf8"
);

/** Token names `theme.css` declares under a namespace, minus sub-keys. */
function tokens(namespace: string): string[] {
  const names = [
    ...themeCss.matchAll(new RegExp(`--${namespace}-([a-z0-9-]+):`, "g")),
  ].map((m) => m[1] ?? "");
  return [...new Set(names.filter((n) => n && !n.includes("--")))];
}

describe("cn", () => {
  it("drops falsy values and lets the later Tailwind class win", () => {
    const hidden = false;
    expect(cn("p-2", hidden && "hidden", "p-4")).toBe("p-4");
  });

  it("lets a later icon weight replace an earlier one", () => {
    expect(cn("icon-light size-3", "icon-bold")).toBe("size-3 icon-bold");
  });
});

// A theme token tailwind-merge does not know is mis-grouped: `text-label`
// reads as a color and `font-wordmark` as a font family, so cn() drops a
// class it should keep. Every token in theme.css must merge as its own kind.
describe("cn knows every theme.css token", () => {
  it.each(tokens("text"))("text-%s is a size, not a color", (name) => {
    expect(cn(`text-${name}`, "text-muted-foreground")).toBe(
      `text-${name} text-muted-foreground`
    );
    expect(cn("text-xs", `text-${name}`)).toBe(`text-${name}`);
  });

  it.each(tokens("radius"))("rounded-%s is a radius", (name) => {
    expect(cn("rounded-full", `rounded-${name}`)).toBe(`rounded-${name}`);
  });

  it.each(tokens("tracking"))("tracking-%s is tracking", (name) => {
    expect(cn("tracking-normal", `tracking-${name}`)).toBe(`tracking-${name}`);
  });

  it.each(tokens("leading"))("leading-%s is a line height", (name) => {
    expect(cn("leading-4", `leading-${name}`)).toBe(`leading-${name}`);
  });

  it.each(tokens("font-weight"))("font-%s is a weight", (name) => {
    expect(cn("font-normal", `font-${name}`)).toBe(`font-${name}`);
    expect(cn("font-sans", `font-${name}`)).toBe(`font-sans font-${name}`);
  });

  it("finds the tokens it checks", () => {
    expect(tokens("text")).toContain("label");
    expect(tokens("radius")).toContain("control");
    expect(tokens("font-weight")).toContain("wordmark");
    expect(tokens("leading")).toContain("compact");
  });
});
