import { appKeys } from "@core/query-keys";
import { act, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { expect, it } from "vitest";
import { useWindowAppearance } from "./use-window-appearance";

function Root() {
  useWindowAppearance();
  return null;
}

it("reads the appearance once, then follows its event", async () => {
  const { transport, queryClient, unmount } = renderWithProviders(<Root />);
  await waitFor(() =>
    expect(queryClient.getQueryData(appKeys.appearance)).toBeDefined()
  );
  expect(document.documentElement.hasAttribute("data-performance")).toBe(false);
  act(() => transport.setLowPowerMode(true));
  await waitFor(() =>
    expect(document.documentElement.hasAttribute("data-performance")).toBe(true)
  );
  expect(
    transport.calls.filter((c) => c.command === "get_window_appearance")
  ).toHaveLength(1);
  unmount();
  transport.dispose();
  document.documentElement.removeAttribute("data-performance");
  document.documentElement.classList.remove("dark");
});
