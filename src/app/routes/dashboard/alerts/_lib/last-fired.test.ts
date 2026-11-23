import { DAY_MS, HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { lastFiredText } from "./last-fired";

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

describe("lastFiredText", () => {
  it.each([
    ["seconds ago", 59_999, "Last fired just now"],
    ["a time ahead of the clock", -5 * MINUTE_MS, "Last fired just now"],
    ["exactly a minute ago", MINUTE_MS, "Last fired 1 min ago"],
    ["just under an hour ago", HOUR_MS - 1, "Last fired 59 min ago"],
    ["72 minutes ago", 72 * MINUTE_MS, "Last fired 1 h ago"],
    ["just under a day ago", DAY_MS - 1, "Last fired 23 h ago"],
    ["three and a half days ago", 3.5 * DAY_MS, "Last fired 3 d ago"],
  ])("reads %s", (_case, agoMs, text) => {
    expect(lastFiredText(NOW - agoMs, NOW)).toBe(text);
  });
});
