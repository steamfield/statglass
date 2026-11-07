import { act, render, screen } from "@testing-library/react";
import { COPIED_MS } from "~/hooks/use-copy-to-clipboard";
import { Command } from "./ssh-setup-help";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});
afterEach(() => {
  vi.useRealTimers();
  writeText.mockReset();
});

describe("Command", () => {
  it("offers Copy again after a copy, while the status line resets", async () => {
    writeText.mockResolvedValue();
    render(<Command text="ssh studio true" />);
    await act(async () => {
      screen.getByRole("button", { name: "Copy" }).click();
    });
    expect(writeText).toHaveBeenCalledWith("ssh studio true");
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    act(() => vi.advanceTimersByTime(COPIED_MS));
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(
      screen.getByRole("button", { name: "Copy again" })
    ).toBeInTheDocument();
  });
});
