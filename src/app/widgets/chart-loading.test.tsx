import { render } from "@testing-library/react";
import { ChartLoading } from "./chart-loading";
import styles from "./chart-loading.module.css";

it("renders one decorative clipped track with one scan segment and the supplied position", () => {
  const { container } = render(<ChartLoading className="inset-x-0 bottom-0" />);
  const tracks = container.querySelectorAll("[data-chart-loading]");
  expect(tracks).toHaveLength(1);
  const track = tracks[0];
  expect(track).toHaveAttribute("aria-hidden", "true");
  expect(track).not.toHaveAttribute("role");
  expect(track).toHaveClass(
    "inset-x-0",
    "bottom-0",
    "h-px",
    "overflow-hidden",
    "pointer-events-none",
    "absolute"
  );
  expect(track?.children).toHaveLength(1);
  expect(track?.firstElementChild).toHaveClass(styles.scan ?? "");
  expect(track?.textContent).toBe("");
});
