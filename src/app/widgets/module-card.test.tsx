import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectJsonRoundTrip } from "@tests/widget-json";
import { useState } from "react";
import { ModuleCard, type ModuleCardProps } from "./module-card";

const PROPS: ModuleCardProps = {
  accent: "mem",
  title: "Memory",
  value: "17.6",
  unit: " / 24 GB",
};

function FooterCard({
  onOpen = () => {},
  onFooter = () => {},
  leader = true,
}: {
  onOpen?: (href: string) => void;
  onFooter?: () => void;
  leader?: boolean;
}) {
  const [compact, setCompact] = useState(false);
  return (
    <ModuleCard
      accent="cpu"
      title="Containers"
      value="3 running"
      href="/dashboard/containers"
      onOpen={onOpen}
      compact={compact}
      onToggle={() => setCompact((c) => !c)}
      footer={
        leader ? (
          <button type="button" onClick={onFooter}>
            Highest CPU: web · 12%
          </button>
        ) : null
      }
    >
      <span>1.20 cores · 2.1 GB</span>
    </ModuleCard>
  );
}

describe("ModuleCard", () => {
  it("round-trips its props through JSON", () => {
    expectJsonRoundTrip(ModuleCard, PROPS);
    expectJsonRoundTrip(ModuleCard, {
      accent: "cpu",
      title: "Cores",
      subtitle: "% load",
      subtitleStyle: "label",
    });
  });

  it("is a region named by its title", () => {
    render(<ModuleCard {...PROPS} />);
    expect(screen.getByRole("region", { name: "Memory" })).toBeInTheDocument();
  });

  describe("with a footer", () => {
    it("names the link by the title only", () => {
      render(<FooterCard />);
      expect(
        screen.getByRole("link", { name: "Containers" })
      ).toBeInTheDocument();
    });

    it("keeps the footer button outside the link", () => {
      render(<FooterCard />);
      const link = screen.getByRole("link", { name: "Containers" });
      const button = screen.getByRole("button", { name: /Highest CPU/ });
      expect(link).not.toContainElement(button);
    });

    it("runs the footer action without opening the card", async () => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      const onFooter = vi.fn();
      render(<FooterCard onOpen={onOpen} onFooter={onFooter} />);
      await user.click(screen.getByRole("button", { name: /Highest CPU/ }));
      expect(onFooter).toHaveBeenCalledOnce();
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("tabs from the collapse toggle to the link to the footer", async () => {
      const user = userEvent.setup();
      render(<FooterCard />);
      await user.tab();
      expect(
        screen.getByRole("button", { name: "Collapse Containers" })
      ).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("link", { name: "Containers" })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("button", { name: /Highest CPU/ })).toHaveFocus();
    });

    it("keeps its shell when the footer content goes away", () => {
      const { rerender } = render(<FooterCard />);
      const link = screen.getByRole("link", { name: "Containers" });
      link.focus();
      rerender(<FooterCard leader={false} />);
      expect(screen.getByRole("link", { name: "Containers" })).toBe(link);
      expect(link).toHaveFocus();
    });
  });
});
