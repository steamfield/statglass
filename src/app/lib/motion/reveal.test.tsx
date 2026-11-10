import { render } from "@testing-library/react";
import { mockElementAnimate } from "@tests/test-utils";
import { useReveal } from "./reveal";

function Data({
  loading,
  count = 2,
  self = false,
}: {
  loading?: boolean;
  count?: number;
  self?: boolean;
}) {
  return (
    <div
      ref={useReveal<HTMLDivElement>(loading)}
      data-reveal={self || undefined}
    >
      {!self &&
        ["first", "second", "later"]
          .slice(0, count)
          .map((key) => <div key={key} data-reveal />)}
    </div>
  );
}

beforeEach(() =>
  document.documentElement.style.setProperty("--motion-enter", "280ms")
);
afterEach(() =>
  document.documentElement.style.removeProperty("--motion-enter")
);

describe("useReveal", () => {
  it.each([false, undefined])(
    "does not animate a ready mount (%s)",
    (loading) => {
      const animate = mockElementAnimate();
      const { rerender } = render(
        <Data {...(loading === undefined ? {} : { loading })} />
      );
      rerender(<Data loading={false} />);
      expect(animate).not.toHaveBeenCalled();
    }
  );
  it.each([false, true])(
    "animates each marked target once at the committed loading flip (self: %s)",
    (self) => {
      const animate = mockElementAnimate();
      const { container, rerender } = render(<Data loading self={self} />);
      expect(animate).not.toHaveBeenCalled();
      rerender(<Data loading={false} self={self} />);
      const targets = [...container.querySelectorAll("[data-reveal]")];
      expect(animate.mock.contexts).toEqual(targets);
      for (const call of animate.mock.calls)
        expect(call).toEqual([
          [
            { opacity: 0, transform: "scaleY(0.9)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 280, easing: "ease-out", id: "reveal" },
        ]);
      rerender(<Data loading={false} self={self} count={3} />);
      expect(animate).toHaveBeenCalledTimes(targets.length);
      document.documentElement.style.setProperty("--motion-enter", "0ms");
      rerender(<Data loading={false} self={self} count={3} />);
      document.documentElement.style.setProperty("--motion-enter", "280ms");
      rerender(<Data loading={false} self={self} count={3} />);
      expect(animate).toHaveBeenCalledTimes(targets.length);
      rerender(<Data loading self={self} count={3} />);
      rerender(<Data loading={false} self={self} count={3} />);
      expect(animate).toHaveBeenCalledTimes(targets.length + (self ? 1 : 3));
    }
  );
  it("does not animate or replay a flip with a zero duration", () => {
    const animate = mockElementAnimate();
    document.documentElement.style.setProperty("--motion-enter", "0ms");
    const { rerender } = render(<Data loading />);
    rerender(<Data loading={false} />);
    document.documentElement.style.setProperty("--motion-enter", "280ms");
    rerender(<Data loading={false} />);
    expect(animate).not.toHaveBeenCalled();
  });
});
