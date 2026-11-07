import { fireEvent, render, screen } from "@testing-library/react";
import { OVERVIEW_CARDS, PASSIVE_COOLING_CARD } from "./lib/sample-props";
import { MetricCard } from "./metric-card";

const CPU = OVERVIEW_CARDS[0];
const GPU = OVERVIEW_CARDS[1];
if (!CPU || !GPU) throw new Error("Missing card samples");

describe("MetricCard", () => {
  it("renders its headline, chart, compact facts and captioned live list", () => {
    render(<MetricCard {...CPU} />);
    expect(screen.getByText("18%")).toBeVisible();
    expect(
      screen.getByRole("img", { name: "CPU total and system, last 5 minutes" })
    ).toBeVisible();
    expect(screen.getByText("User")).toBeVisible();
    expect(screen.getByText("Now")).toBeVisible();
    expect(
      screen.getByRole("list", { name: "Top processes by CPU" })
    ).toBeVisible();
  });

  it("renders the source unit and passive cooling fact", () => {
    render(<MetricCard {...PASSIVE_COOLING_CARD} />);
    expect(screen.getByText("on adapter")).toBeVisible();
    expect(screen.getByText("Passive cooling")).toBeVisible();
  });

  it.each(["warn", "critical"] as const)(
    "shows %s pressure as a header chip with an icon",
    (tone) => {
      const { container } = render(
        <MetricCard {...CPU} alert={{ tone, text: `Pressure ${tone}` }} />
      );
      expect(screen.getByText(`Pressure ${tone}`)).toBeVisible();
      expect(container.querySelector("svg.lucide")).toHaveAttribute(
        "aria-hidden",
        "true"
      );
    }
  );

  it("is a link named by its title that hands navigation to the route", () => {
    const onOpen = vi.fn();
    render(<MetricCard {...CPU} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("link", { name: "CPU" }));
    expect(onOpen).toHaveBeenCalledWith("/dashboard/cpu");
  });

  it("is a plain region without an href", () => {
    const { href: _href, ...rest } = CPU;
    render(<MetricCard {...rest} />);
    expect(screen.getByRole("region", { name: "CPU" })).toBeInTheDocument();
  });

  it("keeps its chart when no list is supplied", () => {
    render(<MetricCard {...GPU} />);
    expect(
      screen.getByRole("img", { name: "GPU utilization, last 5 minutes" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("Now")).toBeNull();
  });
});
