/** Reading the app's own source in a test, for conventions a linter cannot express. */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface MobileSource {
  /** Path under `apps/mobile/src`, with forward slashes. */
  file: string;
  source: string;
}

/** Every TypeScript and JavaScript file under `apps/mobile/src`. */
export function mobileSources(): MobileSource[] {
  const src = resolve(__dirname, "../../src");
  return readdirSync(src, { encoding: "utf8", recursive: true })
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .map((file) => ({ file, source: readFileSync(join(src, file), "utf8") }));
}

/**
 * Every opening tag of the named JSX elements in a source file, from `<Name`
 * to its closing `>`, with the expressions inside it (ternaries, spreads,
 * arrow functions) kept whole.
 *
 * @param names - Element names, such as `Text` or `Animated.View`. `Text` does not match `TextInput`.
 */
export function openingTags(
  source: string,
  names: readonly string[]
): string[] {
  const escaped = names.map((name) => name.replace(".", "\\."));
  const start = new RegExp(`<(?:${escaped.join("|")})(?=[\\s>])`, "g");
  const tags: string[] = [];
  for (const match of source.matchAll(start)) {
    let depth = 0;
    let end = match.index;
    for (; end < source.length; end++) {
      const char = source[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0 && source[end - 1] !== "=") break;
    }
    tags.push(source.slice(match.index, end));
  }
  return tags;
}
