# StatGlass brand assets

The SVGs here are the sources. Run `build.mjs` to regenerate the raster exports,
site icons, social card, and iPhone assets.

| Source                     | Use                                                   |
| -------------------------- | ----------------------------------------------------- |
| `statglass-logo.svg`       | Wordmark on light backgrounds                         |
| `statglass-logo-dark.svg`  | Wordmark on dark backgrounds                          |
| `statglass-icon.svg`       | Mark on light backgrounds (also the site favicon)     |
| `statglass-icon-dark.svg`  | Mark on dark backgrounds                              |
| `statglass-app-icon.svg`   | macOS app icon: the mark on its dark squircle         |

Raster exports are WebP. Logos and icons are lossless with transparency:

- `statglass-logo-{light,dark}-{512,1024,2048}w.webp` (width in pixels)
- `statglass-icon-{light,dark}-{64,256,512,1024}.webp`
- `statglass-app-icon-{256,512,1024}.webp`
- `statglass-og.webp`: the 2560x1340 social card, a 2x screenshot of the landing hero in dark mode

The build also writes the site's icons as PNG, since iOS ignores a WebP touch icon and
crawlers and link unfurlers read PNG and ICO reliably: `docs-site/public/apple-touch-icon.png`
(180) and `icon-{192,512}.png` for the web manifest, which are the app icon cropped to a
full-bleed square because iOS and launchers apply their own mask, and `favicon.ico` (32 and
48), the app icon on its squircle for Google results and other crawlers. Browser tabs keep
`favicon.svg`. With `--og` it also writes `docs-site/public/og.jpg`, the same card at
1200x628 as JPEG, because LinkedIn and some chat unfurlers drop WebP og:images.

The iPhone build uses four 1024×1024 PNGs in `apps/mobile/assets/`.

- `icon-light.png` uses the opaque, full-bleed crop of the macOS icon.
- `icon-dark.png` uses the same cyan grid on a transparent background so iOS can add its dark fill.
- `icon-tinted.png` uses a grayscale grid with a translucent dark backing. Expo composites it onto white before iOS applies the tint.
- `splash-icon.png` uses the standalone cyan mark so the launch screen's theme background shows through.

## Regenerating

Needs `rsvg-convert` and `cwebp` (`brew install librsvg webp`).

```bash
node brand/build.mjs
```

The social card is a screenshot, so retake it whenever the landing hero changes. Serve a
production build of the site, then pass its URL:

```bash
cd docs-site && make build && make preview
node brand/build.mjs --og http://localhost:4321/
```
