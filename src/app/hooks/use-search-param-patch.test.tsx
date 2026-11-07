import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import {
  patchSearchParams,
  useSearchParamPatch,
} from "./use-search-param-patch";

describe("patchSearchParams", () => {
  it("sets, deletes and replaces lists without touching other keys", () => {
    const next = patchSearchParams(
      new URLSearchParams("q=web&collapsed=a&collapsed=b&sort=cpu"),
      { q: null, collapsed: ["b", "c"], dir: "asc" }
    );
    expect(next.toString()).toBe("sort=cpu&collapsed=b&collapsed=c&dir=asc");
  });

  it("returns to the first page unless the patch sets the page", () => {
    const params = new URLSearchParams("retainedOffset=64&retainedQuery=a");
    expect(
      patchSearchParams(
        params,
        { retainedQuery: "b" },
        "retainedOffset"
      ).toString()
    ).toBe("retainedQuery=b");
    expect(
      patchSearchParams(
        params,
        { retainedOffset: "96" },
        "retainedOffset"
      ).toString()
    ).toBe("retainedOffset=96&retainedQuery=a");
    expect(patchSearchParams(params, { retainedQuery: "b" }).toString()).toBe(
      "retainedOffset=64&retainedQuery=b"
    );
  });

  it("leaves its input unchanged", () => {
    const params = new URLSearchParams("a=1");
    patchSearchParams(params, { a: null });
    expect(params.toString()).toBe("a=1");
  });
});

describe("useSearchParamPatch", () => {
  function setup() {
    const patch: { current?: ReturnType<typeof useSearchParamPatch> } = {};
    function Probe() {
      patch.current = useSearchParamPatch();
      return null;
    }
    const router = createMemoryRouter([{ path: "/", element: <Probe /> }], {
      initialEntries: ["/?view=a"],
    });
    render(<RouterProvider router={router} />);
    const current = () => {
      if (!patch.current) throw new Error("router did not render");
      return patch.current;
    };
    return { router, current };
  }

  it("replaces the history entry by default and pushes on request", () => {
    const { router, current } = setup();
    act(() => current()({ view: "b" }));
    expect(router.state.location.search).toBe("?view=b");
    expect(router.state.historyAction).toBe("REPLACE");
    act(() => current()({ chart: "x" }, { push: true }));
    expect(router.state.location.search).toBe("?view=b&chart=x");
    expect(router.state.historyAction).toBe("PUSH");
  });
});
