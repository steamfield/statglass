import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IPhoneDemo } from "./IPhoneDemo";

let report: (visible: boolean) => void = () => undefined;
class FakeObserver {
  targets: Element[] = [];
  constructor(
    private callback: (
      entries: { isIntersecting: boolean; target: Element }[]
    ) => void
  ) {
    report = (visible) =>
      this.callback(
        this.targets.map((target) => ({ isIntersecting: visible, target }))
      );
  }
  observe(element: Element) {
    this.targets.push(element);
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const layers = () =>
  [...document.querySelectorAll<HTMLElement>("[data-layer]")].map(
    (l) => l.dataset.state
  );
const top = () =>
  document.querySelector<HTMLElement>(
    '[data-layer][data-state="top"]'
  ) as HTMLElement;

it("lists the live hosts, and the disabled one without a way in", () => {
  render(<IPhoneDemo />);
  const phone = within(top());
  expect(
    phone.getByRole("button", { name: /^MacBook Pro, live/ })
  ).toBeVisible();
  expect(phone.getByRole("button", { name: /^build, live/ })).toBeVisible();
  expect(phone.queryByRole("button", { name: /^studio/ })).toBeNull();
  expect(phone.getByText("Disabled")).toBeInTheDocument();
});

it("pushes a host, then its CPU page, and goes back a screen at a time", () => {
  render(<IPhoneDemo />);
  fireEvent.click(
    within(top()).getByRole("button", { name: /^MacBook Pro, live/ })
  );
  expect(layers()).toEqual(["below", "top"]);
  // The screen underneath can't be reached while it's covered.
  expect(document.querySelector('[data-state="below"]')).toHaveAttribute(
    "inert"
  );

  fireEvent.click(within(top()).getByRole("button", { name: "CPU" }));
  expect(layers()).toEqual(["below", "below", "top"]);
  expect(
    within(top()).getByRole("group", { name: "Chart range" })
  ).toBeVisible();

  fireEvent.click(
    within(top()).getByRole("button", { name: "Back to MacBook Pro" })
  );
  expect(layers()).toEqual(["below", "top", "leaving"]);
  // Without a transition (as under reduced motion) the fallback drops it.
  act(() => vi.advanceTimersByTime(600));
  expect(layers()).toEqual(["below", "top"]);

  // The host screen comes back from underneath; it doesn't slide in again.
  expect(top()).toHaveTextContent("MacBook Pro");
  expect(top().getAnimations?.() ?? []).toHaveLength(0);

  fireEvent.click(within(top()).getByRole("button", { name: "Back to Hosts" }));
  act(() => vi.advanceTimersByTime(600));
  expect(layers()).toEqual(["top"]);
});

it("keeps keyboard focus inside the phone as screens change", () => {
  render(<IPhoneDemo />);
  const host = within(top()).getByRole("button", {
    name: /^MacBook Pro, live/,
  });
  host.focus();
  fireEvent.click(host);
  const back = within(top()).getByRole("button", { name: "Back to Hosts" });
  expect(back).toHaveFocus();

  fireEvent.click(back);
  act(() => vi.advanceTimersByTime(600));
  expect(
    within(top()).getByRole("button", { name: /^MacBook Pro, live/ })
  ).toHaveFocus();
});

it("switches the CPU chart between the last five minutes and the hour", () => {
  render(<IPhoneDemo />);
  fireEvent.click(within(top()).getByRole("button", { name: /^build, live/ }));
  fireEvent.click(within(top()).getByRole("button", { name: "CPU" }));
  const phone = within(top());
  expect(phone.getByRole("button", { name: "5m" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(
    phone.getByRole("img", { name: "CPU total, last 5 minutes" })
  ).toBeInTheDocument();
  fireEvent.click(phone.getByRole("button", { name: "1h" }));
  expect(phone.getByRole("button", { name: "1h" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(
    phone.getByRole("img", { name: "CPU total, last hour" })
  ).toBeInTheDocument();
});

it("ticks forward once a second while it's on screen", () => {
  render(<IPhoneDemo />);
  const label = () =>
    within(top())
      .getAllByRole("button", { name: /, live\./ })
      .map((b) => b.getAttribute("aria-label"))
      .join("|");
  const first = label();
  act(() => vi.advanceTimersByTime(3000));
  // Off screen, nothing moves.
  expect(label()).toBe(first);
  act(() => report(true));
  const seen = new Set([first]);
  for (let i = 0; i < 5; i += 1) {
    act(() => vi.advanceTimersByTime(1000));
    seen.add(label());
  }
  expect(seen.size).toBeGreaterThan(1);

  // Scrolled away, it holds its last frame.
  act(() => report(false));
  const held = label();
  act(() => vi.advanceTimersByTime(5000));
  expect(label()).toBe(held);
});

it("keeps a covered screen on its last frame while the top one ticks", () => {
  render(<IPhoneDemo />);
  act(() => report(true));
  fireEvent.click(within(top()).getByRole("button", { name: /^nas, live/ }));
  const below = document.querySelector<HTMLElement>(
    '[data-layer][data-state="below"]'
  ) as HTMLElement;
  const covered = below.innerHTML;
  act(() => vi.advanceTimersByTime(5000));
  expect(below.innerHTML).toBe(covered);
});
