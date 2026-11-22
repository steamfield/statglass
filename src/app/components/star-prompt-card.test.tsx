import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StarPromptCard } from "./star-prompt-card";

describe("StarPromptCard", () => {
  it("renders honest copy, non-modal status landmark, and Not now when canSnooze is true", async () => {
    const user = userEvent.setup();
    const onStar = vi.fn();
    const onSnooze = vi.fn();
    const onDismiss = vi.fn();

    render(
      <StarPromptCard
        canSnooze={true}
        onStar={onStar}
        onSnooze={onSnooze}
        onDismiss={onDismiss}
      />
    );

    const card = screen.getByRole("status", {
      name: /star statglass on github/i,
    });
    expect(card).toBeInTheDocument();
    expect(screen.getByText("Enjoying StatGlass?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "StatGlass is free and open source. A star on GitHub helps others discover it."
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Star on GitHub" }));
    expect(onStar).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onSnooze).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows Don't ask again instead of Not now when canSnooze is false", async () => {
    const user = userEvent.setup();
    const onSnooze = vi.fn();
    const onDismiss = vi.fn();

    render(
      <StarPromptCard
        canSnooze={false}
        onStar={vi.fn()}
        onSnooze={onSnooze}
        onDismiss={onDismiss}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Not now" })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Don't ask again" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSnooze).not.toHaveBeenCalled();
  });

  it("dismisses when Escape is pressed while focused inside the card", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    render(
      <StarPromptCard
        canSnooze={true}
        onStar={vi.fn()}
        onSnooze={vi.fn()}
        onDismiss={onDismiss}
      />
    );

    const cta = screen.getByRole("button", { name: "Star on GitHub" });
    cta.focus();
    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
