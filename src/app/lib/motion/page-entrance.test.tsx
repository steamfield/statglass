import { act, render } from "@testing-library/react";
import { mockElementAnimate } from "@tests/test-utils";
import { usePageEntrance } from "./page-entrance";

function Page({
  pageKey = "/dashboard/cpu",
  cards = 3,
  late = false,
  lateDetail = false,
  lateBlock = false,
  row = true,
  value = 0,
}: {
  pageKey?: string;
  cards?: number;
  late?: boolean;
  lateDetail?: boolean;
  lateBlock?: boolean;
  row?: boolean;
  value?: number;
}) {
  const ref = usePageEntrance<HTMLDivElement>(pageKey);
  return (
    <div ref={ref}>
      <div>
        <header>Title {value}</header>
        {row && (
          <div data-testid="row" data-enter-group>
            {Array.from({ length: cards }, (_, i) => (
              <section key={`card-${i.toString()}`} data-card>
                card {i} {i === 0 && lateDetail && <p>detail</p>}
              </section>
            ))}
          </div>
        )}
        {lateBlock && <form>settings</form>}
        {late && (
          <section data-card data-testid="late">
            late
          </section>
        )}
      </div>
    </div>
  );
}

const root = document.documentElement;
beforeEach(() => {
  root.style.setProperty("--motion-page", "400ms");
  root.style.setProperty("--motion-stagger", "40ms");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  root.style.removeProperty("--motion-page");
  root.style.removeProperty("--motion-stagger");
  vi.useRealTimers();
});

/** `Element.animate` stubbed to return an animation whose `cancel` is a spy. */
function mockAnimate() {
  const animate = mockElementAnimate();
  const cancel = vi.fn();
  animate.mockImplementation(() => ({ cancel }) as unknown as Animation);
  return Object.assign(animate, { cancel });
}

const targets = (animate: ReturnType<typeof mockAnimate>) =>
  animate.mock.contexts.map((el) =>
    el instanceof Element ? (el.textContent ?? "").trim() : ""
  );
const delays = (animate: ReturnType<typeof mockAnimate>) =>
  animate.mock.calls.map(([, options]) =>
    typeof options === "object" ? options.delay : undefined
  );

describe("usePageEntrance", () => {
  it("enters the header, then each card in reading order, never the group holding them", () => {
    const animate = mockAnimate();
    const { getByTestId } = render(<Page />);
    expect(targets(animate)).toEqual(["Title 0", "card 0", "card 1", "card 2"]);
    expect(delays(animate)).toEqual([0, 40, 80, 120]);
    expect(animate.mock.contexts).not.toContain(getByTestId("row"));
    for (const [, options] of animate.mock.calls)
      expect(options).toMatchObject({
        duration: 400,
        fill: "backwards",
        id: "page-enter",
      });
  });

  it("caps the stagger so a long page doesn't trickle in", () => {
    const animate = mockAnimate();
    render(<Page cards={12} />);
    expect(delays(animate).at(-1)).toBe(320);
  });

  it("does not replay on a data update, and replays when the page changes", () => {
    const animate = mockAnimate();
    const { rerender } = render(<Page />);
    animate.mockClear();
    rerender(<Page value={1} />);
    vi.advanceTimersByTime(2000);
    rerender(<Page value={2} />);
    expect(animate).not.toHaveBeenCalled();

    rerender(<Page pageKey="/dashboard/gpu" value={3} />);
    expect(targets(animate)).toEqual(["Title 3", "card 0", "card 1", "card 2"]);
  });

  it("continues the entrance for cards that mount while the page opens, as their own batch", async () => {
    const animate = mockAnimate();
    const { rerender, getByTestId } = render(<Page cards={0} />);
    animate.mockClear();
    vi.advanceTimersByTime(100);
    await act(async () => rerender(<Page cards={2} late />));
    expect(targets(animate)).toEqual(["card 0", "card 1", "late"]);
    expect(delays(animate)).toEqual([0, 40, 80]);
    expect(animate.mock.contexts).toContain(getByTestId("late"));
  });

  it("enters content that fills the route's root after its header", async () => {
    const animate = mockAnimate();
    const { rerender } = render(<Page row={false} />);
    expect(targets(animate)).toEqual(["Title 0"]);
    animate.mockClear();
    await act(async () => rerender(<Page row={false} lateBlock />));
    expect(targets(animate)).toEqual(["settings"]);
  });

  it("leaves content added inside an entered card alone", async () => {
    const animate = mockAnimate();
    const { rerender } = render(<Page />);
    animate.mockClear();
    await act(async () => rerender(<Page lateDetail />));
    expect(animate).not.toHaveBeenCalled();
  });

  it("enters a card once when something inside it lands in the same batch", async () => {
    const animate = mockAnimate();
    const { getByTestId } = render(<Page />);
    animate.mockClear();
    await act(async () => {
      const card = document.createElement("section");
      card.setAttribute("data-card", "");
      card.textContent = "new card";
      getByTestId("row").append(card);
      const chart = document.createElement("div");
      chart.textContent = "chart";
      card.append(chart);
    });
    expect(targets(animate)).toEqual(["new cardchart"]);
  });

  it("leaves rows added to an entered block alone", async () => {
    const animate = mockAnimate();
    const { getByRole } = render(<Page />);
    animate.mockClear();
    await act(async () => {
      const row = document.createElement("p");
      row.textContent = "new row";
      getByRole("banner").append(row);
    });
    expect(animate).not.toHaveBeenCalled();
  });

  it("cancels what is still running when the page changes or unmounts", () => {
    const animate = mockAnimate();
    const { rerender, unmount } = render(<Page />);
    rerender(<Page pageKey="/dashboard/gpu" />);
    expect(animate.cancel).toHaveBeenCalledTimes(4);
    unmount();
    expect(animate.cancel).toHaveBeenCalledTimes(8);
  });

  it("lets cards that mount after the opening window appear in place", async () => {
    const animate = mockAnimate();
    const { rerender } = render(<Page />);
    animate.mockClear();
    vi.advanceTimersByTime(1000);
    await act(async () => rerender(<Page late />));
    expect(animate).not.toHaveBeenCalled();
  });

  it("does nothing when the token is 0 ms (Reduce Motion, Performance mode)", () => {
    root.style.setProperty("--motion-page", "0ms");
    const animate = mockAnimate();
    render(<Page />);
    expect(animate).not.toHaveBeenCalled();
  });
});
