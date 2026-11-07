import { CommandFailure } from "@core/transport";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InlineMessage } from "./inline-message";
import { QueryNotice } from "./query-notice";

const pending = { isPending: true, isError: false, error: null };
const failed = { isPending: false, isError: true, error: new Error("lost") };
const done = { isPending: false, isError: false, error: null };

describe("QueryNotice", () => {
  it("says it is loading while pending, even with an empty line on offer", () => {
    render(
      <QueryNotice query={pending} loading="Loading…" error="x" empty="None." />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  });

  it("announces a failure as an alert, worded from the error", () => {
    render(
      <QueryNotice
        query={failed}
        loading="Loading…"
        error={(e) => `Couldn't load: ${e.message}`}
        empty="None."
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load: lost");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a failed refetch visible beside held data, before any empty line", () => {
    render(
      <QueryNotice
        query={failed}
        loading="Loading…"
        error="Stale."
        empty="None."
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Stale.");
    expect(screen.queryByText("None.")).toBeNull();
  });

  it("words an expected absence as status, not an alert", () => {
    const off = {
      isPending: false,
      isError: true,
      error: new CommandFailure({ kind: "history_unavailable" }),
    };
    render(<QueryNotice query={off} loading="Loading…" error="History off." />);
    expect(screen.getByRole("status")).toHaveTextContent("History off.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the empty line after success, and nothing when there is data", () => {
    const { rerender, container } = render(
      <QueryNotice query={done} loading="Loading…" error="x" empty="None." />
    );
    expect(screen.getByRole("status")).toHaveTextContent("None.");
    rerender(
      <QueryNotice query={done} loading="Loading…" error="x" empty={false} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("InlineMessage", () => {
  it("gives each tone its role", () => {
    render(
      <>
        <InlineMessage tone="status">Saved.</InlineMessage>
        <InlineMessage tone="error">Failed.</InlineMessage>
        <InlineMessage tone="note">Sampled every 10 s.</InlineMessage>
      </>
    );
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    expect(screen.getByRole("alert")).toHaveTextContent("Failed.");
    const note = screen.getByText("Sampled every 10 s.").closest("p");
    expect(note).not.toHaveAttribute("role");
  });
});
