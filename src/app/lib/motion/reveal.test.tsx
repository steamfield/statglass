import { render } from "@testing-library/react";
import styles from "./motion.module.css";
import { useReveal } from "./reveal";

function Data({ loading }: { loading?: boolean | undefined }) {
  return <div data-testid="data" className={useReveal(loading)} />;
}

describe("useReveal", () => {
  it.each([false, undefined])(
    "does not reveal a chart mounted ready (%s)",
    (loading) => {
      const { getByTestId, rerender } = render(<Data loading={loading} />);
      expect(getByTestId("data")).not.toHaveClass(styles.reveal ?? "");
      rerender(<Data loading={false} />);
      expect(getByTestId("data")).not.toHaveClass(styles.reveal ?? "");
    }
  );

  it("reveals after loading, keeps the node and class across ticks, and repeats for a new load", () => {
    const { getByTestId, rerender } = render(<Data loading />);
    const node = getByTestId("data");
    expect(node).not.toHaveClass(styles.reveal ?? "");
    rerender(<Data loading={false} />);
    expect(node).toHaveClass(styles.reveal ?? "");
    rerender(<Data loading={false} />);
    expect(getByTestId("data")).toBe(node);
    expect(node).toHaveClass(styles.reveal ?? "");
    rerender(<Data loading />);
    expect(node).not.toHaveClass(styles.reveal ?? "");
    rerender(<Data loading={false} />);
    expect(getByTestId("data")).toBe(node);
    expect(node).toHaveClass(styles.reveal ?? "");
  });
});
