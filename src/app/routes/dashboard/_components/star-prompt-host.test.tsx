import { createMockTransport } from "@core/mock-transport";
import { GITHUB_REPO_URL } from "@core/star-prompt";
import { act, fireEvent, screen } from "@testing-library/react";
import { Toaster } from "~/components/ui/sonner";
import OnboardingRoute from "~/routes/onboarding/route";
import PopoverRoute from "~/routes/popover/route";
import { renderWithProviders } from "../../../../../tests/test-utils";
import DashboardLayout from "../route";
import { StarPromptHost } from "./star-prompt-host";

describe("StarPromptHost", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the calm-moment delay before showing and opens GitHub on Star", async () => {
    vi.useFakeTimers();
    const transport = createMockTransport({
      scenarios: ["star-prompt", "paused"],
      historyRows: 60,
    });
    const mounted = renderWithProviders(
      <>
        <StarPromptHost hasFocalNotice={false} delayMs={8_000} />
        <Toaster />
      </>,
      { transport, route: "/dashboard/overview" }
    );

    try {
      await act(() => vi.advanceTimersByTimeAsync(7_900));
      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(
        screen.getByRole("status", { name: /star statglass on github/i })
      ).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Star on GitHub" }));
      });

      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();
      expect(
        transport.calls.some(
          (c) => c.command === "open_url" && c.args[0] === GITHUB_REPO_URL
        )
      ).toBe(true);
      expect(
        transport.calls.some(
          (c) => c.command === "act_on_star_prompt" && c.args[0] === "starred"
        )
      ).toBe(true);
    } finally {
      mounted.unmount();
      transport.dispose();
    }
  });

  it("persists snooze on Not now and permanent dismiss on Dismiss", async () => {
    vi.useFakeTimers();
    const snoozeTransport = createMockTransport({
      scenarios: ["star-prompt", "paused"],
      historyRows: 60,
    });
    const snoozeView = renderWithProviders(
      <StarPromptHost hasFocalNotice={false} delayMs={50} />,
      { transport: snoozeTransport, route: "/dashboard/overview" }
    );
    try {
      await act(() => vi.advanceTimersByTimeAsync(100));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      });
      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();
      expect(
        snoozeTransport.calls.some(
          (c) => c.command === "act_on_star_prompt" && c.args[0] === "snoozed"
        )
      ).toBe(true);
    } finally {
      snoozeView.unmount();
      snoozeTransport.dispose();
    }

    const dismissTransport = createMockTransport({
      scenarios: ["star-prompt", "paused"],
      historyRows: 60,
    });
    const dismissView = renderWithProviders(
      <StarPromptHost hasFocalNotice={false} delayMs={50} />,
      { transport: dismissTransport, route: "/dashboard/overview" }
    );
    try {
      await act(() => vi.advanceTimersByTimeAsync(100));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      });
      expect(
        dismissTransport.calls.some(
          (c) => c.command === "act_on_star_prompt" && c.args[0] === "dismissed"
        )
      ).toBe(true);
    } finally {
      dismissView.unmount();
      dismissTransport.dispose();
    }
  });
});

describe("StarPromptHost calm-moment guards and routes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses when focal error notice, history unavailability, incomplete onboarding, or hidden window is active", async () => {
    vi.useFakeTimers();

    const focalTransport = createMockTransport({
      scenarios: ["star-prompt", "paused"],
      historyRows: 60,
    });
    const focal = renderWithProviders(
      <StarPromptHost hasFocalNotice={true} delayMs={50} />,
      { transport: focalTransport, route: "/dashboard/overview" }
    );
    try {
      await act(() => vi.advanceTimersByTimeAsync(150));
      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();
    } finally {
      focal.unmount();
      focalTransport.dispose();
    }

    const historyTransport = createMockTransport({
      scenarios: ["star-prompt", "history-unavailable", "paused"],
      historyRows: 60,
    });
    const historyView = renderWithProviders(
      <StarPromptHost hasFocalNotice={false} delayMs={50} />,
      { transport: historyTransport, route: "/dashboard/overview" }
    );
    try {
      await act(() => vi.advanceTimersByTimeAsync(150));
      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();
    } finally {
      historyView.unmount();
      historyTransport.dispose();
    }

    const onboardingTransport = createMockTransport({
      scenarios: ["star-prompt", "paused"],
      historyRows: 60,
    });
    await onboardingTransport.updateSettings({
      onboarding: { completed: false },
    });
    const onboardingView = renderWithProviders(
      <StarPromptHost hasFocalNotice={false} delayMs={50} />,
      { transport: onboardingTransport, route: "/dashboard/overview" }
    );
    try {
      await act(() => vi.advanceTimersByTimeAsync(150));
      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();
    } finally {
      onboardingView.unmount();
      onboardingTransport.dispose();
    }

    const hiddenTransport = createMockTransport({
      scenarios: ["star-prompt", "paused"],
      historyRows: 60,
    });
    hiddenTransport.setWindowVisible(false);
    const hiddenView = renderWithProviders(
      <StarPromptHost hasFocalNotice={false} delayMs={50} />,
      { transport: hiddenTransport, route: "/dashboard/overview" }
    );
    try {
      await act(() => vi.advanceTimersByTimeAsync(150));
      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();
    } finally {
      hiddenView.unmount();
      hiddenTransport.dispose();
    }
  });

  it("renders inside DashboardLayout and never in Popover or Onboarding routes", async () => {
    vi.useFakeTimers();
    const dashTransport = createMockTransport({
      scenarios: ["star-prompt", "paused"],
      historyRows: 60,
    });
    const dashView = renderWithProviders(<DashboardLayout />, {
      transport: dashTransport,
      route: "/dashboard/overview",
    });
    try {
      await act(() => vi.advanceTimersByTimeAsync(8_200));
      expect(
        screen.getByRole("status", { name: /star statglass on github/i })
      ).toBeInTheDocument();
    } finally {
      dashView.unmount();
      dashTransport.dispose();
    }

    const popTransport = createMockTransport({
      scenarios: ["star-prompt", "paused"],
      historyRows: 60,
    });
    const popView = renderWithProviders(<PopoverRoute />, {
      transport: popTransport,
      route: "/popover",
    });
    try {
      await act(() => vi.advanceTimersByTimeAsync(8_200));
      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();
    } finally {
      popView.unmount();
      popTransport.dispose();
    }

    const onboardingTransport = createMockTransport({
      scenarios: ["star-prompt", "paused"],
      historyRows: 60,
    });
    const onboardingView = renderWithProviders(<OnboardingRoute />, {
      transport: onboardingTransport,
      route: "/onboarding",
    });
    try {
      await act(() => vi.advanceTimersByTimeAsync(8_200));
      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();
    } finally {
      onboardingView.unmount();
      onboardingTransport.dispose();
    }
  });

  it("resets the calm-moment timer when the window hides and handles post-snooze final dismissal and Escape", async () => {
    vi.useFakeTimers();
    const transport = createMockTransport({
      starPromptStatus: { eligible: true, can_snooze: false },
      scenarios: ["paused"],
      historyRows: 60,
    });
    const view = renderWithProviders(
      <StarPromptHost hasFocalNotice={false} delayMs={1_000} />,
      { transport, route: "/dashboard/overview" }
    );
    try {
      // Hide before delay finishes: timer must cancel and restart when shown again.
      await act(() => vi.advanceTimersByTimeAsync(700));
      act(() => transport.setWindowVisible(false));
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();

      // Show again: needs full 1_000ms from visibility resume.
      act(() => transport.setWindowVisible(true));
      await act(() => vi.advanceTimersByTimeAsync(700));
      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(400));
      expect(
        screen.getByRole("button", { name: "Don't ask again" })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Not now" })
      ).not.toBeInTheDocument();

      const cta = screen.getByRole("button", { name: "Star on GitHub" });
      cta.focus();
      await act(async () => {
        fireEvent.keyDown(cta, { key: "Escape" });
      });
      expect(
        screen.queryByRole("status", { name: /star statglass on github/i })
      ).not.toBeInTheDocument();
      expect(
        transport.calls.some(
          (c) => c.command === "act_on_star_prompt" && c.args[0] === "dismissed"
        )
      ).toBe(true);
      // Mock transport state stays permanently ineligible after dismissal.
      expect(await transport.getStarPromptStatus()).toEqual({
        eligible: false,
        can_snooze: false,
      });
    } finally {
      view.unmount();
      transport.dispose();
    }
  });
});
