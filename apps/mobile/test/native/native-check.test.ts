import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@jest/globals";

const script = resolve(__dirname, "../../../../scripts/mobile/native-check.sh");

function executable(path: string, body = "") {
  writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`, {
    mode: 0o755,
  });
}

test.each([0, 1])(
  "cleans build products when xcodebuild exits %i",
  (exitCode) => {
    const fixture = mkdtempSync(join(tmpdir(), "statglass-native-check-"));
    try {
      const scripts = join(fixture, "scripts/mobile");
      const bin = join(fixture, "bin");
      const temporary = join(fixture, "temporary");
      const defaultDerivedData = join(fixture, "default-derived-data");
      const builtAt = join(fixture, "built-at");
      for (const dir of [
        scripts,
        bin,
        temporary,
        defaultDerivedData,
        join(fixture, "apps/mobile"),
      ]) {
        mkdirSync(dir, { recursive: true });
      }
      const check = join(scripts, "native-check.sh");
      copyFileSync(script, check);
      writeFileSync(join(fixture, "package.json"), "{}");
      writeFileSync(join(fixture, "bun.lock"), "");
      executable(join(scripts, "build-rust-ios.sh"));
      executable(join(bin, "rsync"));
      executable(join(bin, "bun"), 'mkdir -p "$3/ios"');
      executable(join(bin, "pod"));
      executable(
        join(bin, "xcodebuild"),
        `derived="$DEFAULT_DERIVED_DATA/StatGlass-generated"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-derivedDataPath" ]]; then
    derived="$2"
    shift
  fi
  shift
done
mkdir -p "$derived"
touch "$derived/product"
printf '%s' "$derived" > "$BUILT_AT"
exit "$BUILD_EXIT"`
      );

      const result = spawnSync("bash", [check], {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: temporary,
          DEFAULT_DERIVED_DATA: defaultDerivedData,
          BUILT_AT: builtAt,
          BUILD_EXIT: String(exitCode),
        },
      });
      expect(result.status).toBe(exitCode);
      expect(result.stderr).toBe(
        exitCode === 0
          ? ""
          : "mobile-native-check: Xcode simulator build failed\n"
      );
      const derived = readFileSync(builtAt, "utf8");
      expect(existsSync(derived)).toBe(false);
      expect(readdirSync(defaultDerivedData)).toEqual([]);
      expect(readdirSync(temporary)).toEqual([]);
      expect(existsSync(join(fixture, "apps/mobile/ios"))).toBe(false);
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  }
);
