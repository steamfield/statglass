import { useEffect, useState } from "react";

/** A CSS custom property as resolved on `el`, trimmed. */
export function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

type Rgba = readonly [number, number, number, number];

const RGB =
  /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i;

/** `undefined` until first use; `null` once we know there is no canvas. */
let probe: CanvasRenderingContext2D | null | undefined;
const probed = new Map<string, Rgba | null>();

function probeContext(): CanvasRenderingContext2D | null {
  if (probe === undefined) {
    probe =
      typeof document === "undefined"
        ? null
        : document
            .createElement("canvas")
            .getContext("2d", { willReadFrequently: true });
  }
  return probe;
}

/** Whether the canvas accepts `color`: a rejected `fillStyle` is ignored. */
function accepts(ctx: CanvasRenderingContext2D, color: string): boolean {
  ctx.fillStyle = "#000";
  ctx.fillStyle = color;
  const first = String(ctx.fillStyle);
  ctx.fillStyle = "#fff";
  ctx.fillStyle = color;
  return String(ctx.fillStyle) === first;
}

/**
 * Any CSS color a canvas can paint (`oklch()`, `color-mix()`, named colors),
 * as sRGB bytes: paint one pixel and read it back. Cached per string, since
 * tokens repeat on every draw. The canvas stores premultiplied alpha, so a
 * translucent token's RGB comes back quantized (coarser as alpha drops).
 */
function probeColor(color: string): Rgba | null {
  const hit = probed.get(color);
  if (hit !== undefined) return hit;
  const ctx = probeContext();
  let rgba: Rgba | null = null;
  if (ctx && accepts(ctx, color)) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
    rgba = [r, g, b, a / 255];
  }
  probed.set(color, rgba);
  return rgba;
}

function parseColor(color: string): Rgba | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex) {
    const n = Number.parseInt(hex, 16);
    return [n >> 16, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = RGB.exec(color);
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : Number(rgb[4]);
    return [
      Number(rgb[1]),
      Number(rgb[2]),
      Number(rgb[3]),
      rgb[5] ? a / 100 : a,
    ];
  }
  return probeColor(color);
}

/**
 * A color token at `alpha`, multiplied into any alpha the token already has,
 * so canvas fills follow the theme whatever color format it uses. A string
 * that is not a color (an unset token) comes back as is.
 */
export function withAlpha(color: string, alpha: number): string {
  const rgba = parseColor(color.trim());
  if (!rgba) return color;
  const [r, g, b, a] = rgba;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * alpha * 1000) / 1000})`;
}

/** Re-render when `.dark` toggles on <html>: canvas colors are resolved once. */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return version;
}
