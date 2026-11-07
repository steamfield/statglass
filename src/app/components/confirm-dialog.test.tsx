import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clickOutside } from "@tests/test-utils";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, type ConfirmDialogProps } from "./confirm-dialog";

function setup(props: Partial<ConfirmDialogProps> = {}) {
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Quit 2 processes?"
      description="Each process is asked to quit."
      confirmLabel="Quit"
      onConfirm={() => {}}
      {...props}
    />
  );
  return { onOpenChange, user: userEvent.setup() };
}

describe("ConfirmDialog", () => {
  it("lists the items under review with their state", () => {
    setup({
      itemsLabel: "Processes to review",
      items: [
        { key: "1", label: "Safari", status: "Excluded" },
        {
          key: "2",
          label: "Mail",
          note: "PID 2",
          status: "Failed",
          tone: "error",
        },
      ],
    });
    const list = screen.getByRole("list", { name: "Processes to review" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "SafariExcluded",
      "MailPID 2Failed",
    ]);
    expect(within(list).getByText("Failed")).toHaveClass("text-destructive");
  });

  it("does not close on an outside click", async () => {
    const { onOpenChange } = setup();
    await clickOutside();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const { onOpenChange, user } = setup();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("ignores Escape and disables Cancel while locked and busy", async () => {
    const { onOpenChange, user } = setup({ busy: true, lockWhileBusy: true });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quit" })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("can leave only the confirm button for a finished state", () => {
    setup({ cancelLabel: null, confirmLabel: "Done" });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  });
});
