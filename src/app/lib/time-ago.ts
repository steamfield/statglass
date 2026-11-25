import { MINUTE_MS } from "@core/time-grid";

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function agoLabel(nowMs: number, thenMs: number | null): string {
  if (thenMs === null) return "";
  const min = Math.floor((nowMs - thenMs) / MINUTE_MS);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const days = Math.floor(min / (24 * 60));
  if (days >= 1) return days === 1 ? "1 day ago" : `${days} days ago`;
  return `${Math.floor(min / 60)} h ago`;
}
