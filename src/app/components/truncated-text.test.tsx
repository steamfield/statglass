import { createMockTransport } from "@core/mock-transport";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@tests/test-utils";
import { HostSelectionContext } from "~/lib/host-selection";
import { OverviewHostsCard } from "~/routes/dashboard/overview/_components/hosts-card";
import { TruncatedText } from "./truncated-text";

const resizeCallbacks = new Set<() => void>();

class TestResizeObserver implements ResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  private notify = () => this.callback([], this);
  observe() {
    resizeCallbacks.add(this.notify);
  }
  unobserve() {
    resizeCallbacks.delete(this.notify);
  }
  disconnect() {
    resizeCallbacks.delete(this.notify);
  }
}

let scrollWidth = 200;
let clientWidth = 100;

beforeEach(() => {
  scrollWidth = 200;
  clientWidth = 100;
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    () => scrollWidth
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => clientWidth
  );
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resizeCallbacks.clear();
});

describe("TruncatedText", () => {
  it.each([80, 100])(
    "keeps fitting text out of the tab order (width %i)",
    async (width) => {
      scrollWidth = width;
      const user = userEvent.setup();
      render(
        <>
          <TruncatedText text="Studio Mac" />
          <button type="button">Next</button>
        </>
      );
      expect(screen.getByText("Studio Mac")).not.toHaveAttribute("tabindex");
      await user.tab();
      expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
      await user.hover(screen.getByText("Studio Mac"));
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    }
  );

  it.each(["focus", "hover"])(
    "reveals overflowing text on %s",
    async (interaction) => {
      const user = userEvent.setup();
      render(<TruncatedText text="Studio Mac with a long host name" />);
      expect(
        screen.getByText("Studio Mac with a long host name")
      ).toHaveAttribute("tabindex", "0");
      if (interaction === "focus") await user.tab();
      else
        await user.hover(screen.getByText("Studio Mac with a long host name"));
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Studio Mac with a long host name"
      );
    }
  );

  it("removes the tab stop and open tooltip when resized to fit, and restores them when it overflows again", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <TruncatedText text="Studio Mac" />
        <button type="button">Next</button>
      </>
    );
    await user.tab();
    await screen.findByRole("tooltip");

    clientWidth = 240;
    act(() => {
      for (const notify of [...resizeCallbacks]) notify();
    });
    expect(screen.getByText("Studio Mac")).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    clientWidth = 100;
    act(() => {
      for (const notify of [...resizeCallbacks]) notify();
    });
    await waitFor(() =>
      expect(within(container).getByText("Studio Mac")).toHaveAttribute(
        "tabindex",
        "0"
      )
    );
  });

  it("re-measures changed text without waiting for a resize and supports paragraphs", () => {
    const { rerender } = render(
      <TruncatedText as="p" text="Long host name" className="w-40" />
    );
    expect(screen.getByText("Long host name")).toHaveAttribute("tabindex", "0");
    scrollWidth = 80;
    rerender(<TruncatedText as="p" text="Mac" className="w-40" />);
    expect(screen.getByText("Mac").tagName).toBe("P");
    expect(screen.getByText("Mac")).toHaveClass("truncate", "w-40");
    expect(screen.getByText("Mac")).not.toHaveAttribute("tabindex");
  });

  it("wraps an unbroken identifier inside the tooltip", async () => {
    const user = userEvent.setup();
    const text = "studio-mac-with-an-unbroken-host-identifier".repeat(4);
    render(<TruncatedText text={text} />);
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(text);
    expect(screen.getByRole("tooltip")).toHaveClass("break-words");
  });

  it("keeps an overflowing host label outside its row button and both keyboard targets work", async () => {
    const transport = createMockTransport({
      autoTick: false,
      scenarios: ["multi-host"],
    });
    const [remote] = await transport.listRemoteHosts();
    if (!remote) throw new Error("Missing remote fixture");
    const name = "Studio Mac with a long host name";
    await transport.updateRemoteHost({ ...remote.config, name });
    const hosts = await transport.listHosts();
    const local = hosts.find((host) => host.is_local);
    if (!local) throw new Error("Missing local fixture");
    const select = vi.fn();
    const { user } = renderWithProviders(
      <HostSelectionContext value={{ hosts, selected: local.id, select }}>
        <OverviewHostsCard origin="tl" />
      </HostSelectionContext>,
      { transport }
    );
    await screen.findByRole("button", { name: new RegExp(name) });
    const hostName = () =>
      within(screen.getByRole("list", { name: "Other hosts" })).getByText(name);
    expect(
      screen
        .getByRole("button", { name: new RegExp(name) })
        .querySelector("[tabindex]")
    ).toBeNull();
    await user.tab();
    await user.tab();
    expect(hostName()).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(name);
    await user.tab();
    expect(
      screen.getByRole("button", { name: new RegExp(name) })
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(select).toHaveBeenCalledWith(remote.config.id);
    await user.click(hostName());
    expect(select).toHaveBeenCalledTimes(2);
  });
});
