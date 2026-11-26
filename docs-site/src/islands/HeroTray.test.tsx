import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HeroTray } from "./HeroTray";

/** Answers every media query with `wide` (the intro's and the popover's). */
function screenWidth(wide: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: wide,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList
  );
}

afterEach(() => vi.restoreAllMocks());

const item = () =>
  screen.getByRole("button", { name: "StatGlass in the menu bar" });
const popover = () =>
  document.getElementById(
    item().getAttribute("aria-controls") ?? ""
  ) as HTMLElement;

it("opens the popover straight away where the intro doesn't play", () => {
  screenWidth(false);
  render(<HeroTray />);
  expect(item()).toHaveAttribute("aria-expanded", "true");
  expect(popover()).toHaveAttribute("data-open");
  expect(popover()).not.toHaveAttribute("inert");
});

it("starts closed for the intro, out of reach until it opens", () => {
  screenWidth(true);
  render(<HeroTray />);
  expect(item()).toHaveAttribute("aria-expanded", "false");
  expect(popover()).not.toHaveAttribute("data-open");
  expect(popover()).toHaveAttribute("inert");
});

it("opens and closes like the real menu bar item when clicked", () => {
  screenWidth(true);
  render(<HeroTray />);
  fireEvent.click(item());
  expect(item()).toHaveAttribute("aria-expanded", "true");
  expect(popover()).toHaveAttribute("data-open");
  fireEvent.click(item());
  expect(item()).toHaveAttribute("aria-expanded", "false");
  expect(popover()).toHaveAttribute("inert");
});
