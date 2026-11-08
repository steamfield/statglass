import { act, screen, waitFor } from "@testing-library/react";
import { nextFrame } from "@tests/live-frames";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler } from "react";
import { type HostStore, useHostStore } from "~/stores/host-store";
import { useDiskIoScope } from "./use-disk-io";

it.each(["live", "fixed", "selected"] as const)(
  "Disk %s scope subscribes only to edges that determine its range",
  async (mode) => {
    let store: HostStore | undefined;
    const end = Date.now() - 3600000;
    const renders = { n: 0 };
    function Capture() {
      store = useHostStore();
      return null;
    }
    function Scope() {
      const { range } = useDiskIoScope(
        300000,
        mode === "fixed" ? end : null,
        mode === "selected" ? { fromMs: end - 10000, toMs: end } : null
      );
      return <p>{range ? `Ends ${range.toMs}` : "Waiting"}</p>;
    }
    const { transport, queryClient } = renderWithProviders(
      <>
        <Capture />
        <Profiler id="scope" onRender={() => renders.n++}>
          <Scope />
        </Profiler>
      </>
    );
    await screen.findByText(/^Ends /);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const before = renders.n;
    const beforeText = screen.getByText(/^Ends /).textContent;
    const hostStore = store;
    if (!hostStore) throw new Error("Missing live store");
    for (let i = 0; i < 20; i++)
      act(() => transport.push(nextFrame(hostStore.getState())));
    if (mode === "live") {
      expect(renders.n).toBeGreaterThan(before);
      expect(screen.getByText(/^Ends /).textContent).not.toBe(beforeText);
    } else {
      expect(renders.n).toBe(before);
      expect(screen.getByText(`Ends ${end}`)).toBeVisible();
    }
  }
);
