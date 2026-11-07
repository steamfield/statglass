import { render, screen } from "@testing-library/react";
import { ModuleToggleRow } from "./module-toggle-list";

const row = {
  module: "cpu" as const,
  checked: true,
  absence: null,
  onCheckedChange: () => {},
};

describe("ModuleToggleRow", () => {
  it("ties each label to its own switch when a module is listed twice", () => {
    render(
      <>
        <ModuleToggleRow {...row} />
        <ModuleToggleRow {...row} checked={false} />
      </>
    );
    const labels = screen.getAllByText("CPU");
    const switches = screen.getAllByRole("switch");
    expect(labels).toHaveLength(2);
    labels.forEach((label, i) => {
      expect(document.getElementById(label.getAttribute("for") ?? "")).toBe(
        switches[i]
      );
    });
  });

  it("in the onboarding list mutes only a module the host lacks", () => {
    render(
      <ul>
        <ModuleToggleRow {...row} dense checked={false} module="cpu" />
        <ModuleToggleRow {...row} dense absence="No GPU" module="gpu" />
      </ul>
    );
    expect(screen.getByText("CPU")).not.toHaveClass("text-muted-foreground");
    expect(screen.getByText("GPU")).toHaveClass("text-muted-foreground");
  });

  it("in settings mutes a module that is switched off", () => {
    render(<ModuleToggleRow {...row} checked={false} />);
    expect(screen.getByText("CPU")).toHaveClass("text-muted-foreground");
  });
});
