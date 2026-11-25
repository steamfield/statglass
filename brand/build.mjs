#!/usr/bin/env node
// Exports the brand pack, site icons and social card, and iPhone assets from
// the SVG sources beside this file.
//
//   node brand/build.mjs            raster exports only
//   node brand/build.mjs --og URL   also screenshot the landing page at URL
//
// Needs rsvg-convert and cwebp (brew install librsvg webp), and macOS sips. The OG screenshot
// uses the root Playwright install; serve a production build first
// (cd docs-site && make build && make preview).
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const brand = join(root, "brand");
const exportsDir = join(brand, "exports");
const site = join(root, "docs-site/public");

mkdirSync(exportsDir, { recursive: true });

/** Rasterize an SVG at a pixel width and encode it as lossless WebP. */
function webp(svg, width, out) {
  const png = join(tmp, "frame.png");
  execFileSync("rsvg-convert", [
    "--width",
    String(width),
    "--keep-aspect-ratio",
    "-o",
    png,
    svg,
  ]);
  execFileSync("cwebp", ["-quiet", "-lossless", "-exact", png, "-o", out]);
}

/** Rasterize an SVG at a pixel width as PNG. */
function png(svg, width, out) {
  execFileSync("rsvg-convert", [
    "--width",
    String(width),
    "--keep-aspect-ratio",
    "-o",
    out,
    svg,
  ]);
}

/** Pack PNG frames into an .ico (PNG-in-ICO, which every current reader accepts). */
function ico(svg, sizes, out) {
  const frames = sizes.map((size) => {
    const file = join(tmp, `ico-${size}.png`);
    png(svg, size, file);
    return { size, data: readFileSync(file) };
  });
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  writeFileSync(out, Buffer.concat([header, ...frames.map((f) => f.data)]));
}

// iOS and PWA launchers apply their own mask, so the touch icon is the app
// icon's squircle content cropped to a full-bleed square.
const appIcon = readFileSync(join(brand, "statglass-app-icon.svg"), "utf8");
const squircleInset = 100;
const squircleWidth = 824;
const fullBleedSvg = appIcon
  .replace(
    'viewBox="0 0 1024 1024"',
    `viewBox="${squircleInset} ${squircleInset} ${squircleWidth} ${squircleWidth}"`
  )
  .replace(/ rx="18[35]"/g, "");

// Keep the same crop while removing the layers that would cover iOS's dark
// icon background. Match the backing elements regardless of SVG indentation.
const appIconMark = fullBleedSvg.replace(
  /\s*<defs\b[^>]*>[\s\S]*?<\/defs>\s*(?:<rect\b[^>]*\/>\s*){2}(?=<g\s+fill=")/,
  "\n"
);
if (appIconMark === fullBleedSvg) {
  throw new Error(
    "statglass-app-icon.svg must have gradient definitions and two backing rectangles before the tile group"
  );
}

const tmp = mkdtempSync(join(tmpdir(), "statglass-brand-"));
const fullBleed = join(tmp, "app-icon-full-bleed.svg");
writeFileSync(fullBleed, fullBleedSvg);

const jobs = [
  ...["light", "dark"].flatMap((theme) => {
    const suffix = theme === "dark" ? "-dark" : "";
    return [
      ...[512, 1024, 2048].map((w) => [
        join(brand, `statglass-logo${suffix}.svg`),
        w,
        join(exportsDir, `statglass-logo-${theme}-${w}w.webp`),
      ]),
      ...[64, 256, 512, 1024].map((w) => [
        join(brand, `statglass-icon${suffix}.svg`),
        w,
        join(exportsDir, `statglass-icon-${theme}-${w}.webp`),
      ]),
    ];
  }),
  ...[256, 512, 1024].map((w) => [
    join(brand, "statglass-app-icon.svg"),
    w,
    join(exportsDir, `statglass-app-icon-${w}.webp`),
  ]),
];

for (const [svg, width, out] of jobs) webp(svg, width, out);

// Site icons are PNG: iOS ignores a WebP touch icon, and crawlers and link
// unfurlers (Google results, Slack, iMessage) read PNG and ICO reliably.
png(fullBleed, 180, join(site, "apple-touch-icon.png"));
png(fullBleed, 192, join(site, "icon-192.png"));
png(fullBleed, 512, join(site, "icon-512.png"));
// The raster favicon is the app icon on its squircle, so it reads on light and
// dark result pages; Google wants a multiple of 48 px. Tabs keep favicon.svg.
ico(join(brand, "statglass-app-icon.svg"), [32, 48], join(site, "favicon.ico"));

const mobileAssets = join(root, "apps/mobile/assets");
mkdirSync(mobileAssets, { recursive: true });
png(fullBleed, 1024, join(mobileAssets, "icon-light.png"));

const darkIcon = join(tmp, "app-icon-dark.svg");
writeFileSync(darkIcon, appIconMark);
png(darkIcon, 1024, join(mobileAssets, "icon-dark.png"));

// Expo flattens the tinted icon onto white during prebuild. A translucent
// black backing keeps the grayscale tiles lighter than their background.
const tintedIcon = join(tmp, "app-icon-tinted.svg");
const tintedBacking = `<rect x="${squircleInset}" y="${squircleInset}" width="${squircleWidth}" height="${squircleWidth}" fill="#000" fill-opacity=".95"/>`;
writeFileSync(
  tintedIcon,
  appIconMark.replace(/<g\s+fill="[^"]+"/, `${tintedBacking}\n<g fill="#fff"`)
);
png(tintedIcon, 1024, join(mobileAssets, "icon-tinted.png"));

png(
  join(brand, "statglass-icon-dark.svg"),
  1024,
  join(mobileAssets, "splash-icon.png")
);

const ogIndex = process.argv.indexOf("--og");
if (ogIndex !== -1) {
  const url = process.argv[ogIndex + 1];
  if (!url) throw new Error("--og needs the landing page URL");
  const { chromium } = await import(
    join(root, "node_modules/playwright/index.mjs")
  );
  const browser = await chromium.launch();
  // 1280x670 holds the hero and the whole popover at the 1.91:1 OG ratio;
  // 2x gives link previews (iMessage, Slack) a 2560x1340 card.
  const page = await browser.newPage({
    viewport: { width: 1280, height: 670 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await page.goto(url, { waitUntil: "networkidle" });
  // Let the embedded popover fill its sparklines from the mock transport.
  await page.waitForTimeout(2500);
  const shot = join(tmp, "og.png");
  await page.screenshot({ path: shot });
  await browser.close();
  execFileSync("cwebp", [
    "-quiet",
    "-q",
    "90",
    "-m",
    "6",
    shot,
    "-o",
    join(exportsDir, "statglass-og.webp"),
  ]);
  // The site's card is a 1200x628 JPEG: LinkedIn and some chat unfurlers
  // drop WebP og:images, and 1200 px is what the large cards display.
  execFileSync("sips", [
    "-Z",
    "1200",
    "-s",
    "format",
    "jpeg",
    "-s",
    "formatOptions",
    "85",
    shot,
    "--out",
    join(site, "og.jpg"),
  ]);
}

rmSync(tmp, { recursive: true });
