import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IPhoneDemo } from "./IPhoneDemo";

let reportVisible: () => void = () => undefined;
class FakeObserver {
  targets: Element[] = [];
  constructor(
    private callback: (
      entries: { isIntersecting: boolean; target: Element }[]
    ) => void
  ) {
    reportVisible = () =>
      this.callback(
        this.targets.map((target) => ({ isIntersecting: true, target }))
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
    within(top()).getByRole("radiogroup", { name: "Chart range" })
  ).toBeVisible();

  fireEvent.click(
    within(top()).getByRole("button", { name: "Back to MacBook Pro" })
  );
  expect(layers()).toEqual(["below", "top", "leaving"]);
  // Without a transition (as under reduced motion) the fallback drops it.
  act(() => vi.advanceTimersByTime(600));
  expect(layers()).toEqual(["below", "top"]);

  fireEvent.click(within(top()).getByRole("button", { name: "Back to Hosts" }));
  act(() => vi.advanceTimersByTime(600));
  expect(layers()).toEqual(["top"]);
});

it("switches the CPU chart between the last five minutes and the hour", () => {
  render(<IPhoneDemo />);
  fireEvent.click(within(top()).getByRole("button", { name: /^build, live/ }));
  fireEvent.click(within(top()).getByRole("button", { name: "CPU" }));
  const phone = within(top());
  expect(phone.getByRole("radio", { name: "5m" })).toBeChecked();
  expect(
    phone.getByRole("img", { name: "CPU total, last 5 minutes" })
  ).toBeInTheDocument();
  fireEvent.click(phone.getByRole("radio", { name: "1h" }));
  expect(phone.getByRole("radio", { name: "1h" })).toBeChecked();
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
  act(() => reportVisible());
  const seen = new Set([first]);
  for (let i = 0; i < 5; i += 1) {
    act(() => vi.advanceTimersByTime(1000));
    seen.add(label());
  }
  expect(seen.size).toBeGreaterThan(1);
});
