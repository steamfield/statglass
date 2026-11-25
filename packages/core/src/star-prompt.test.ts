import {
  formatSystemDiagnostics,
  GITHUB_ISSUES_URL,
  GITHUB_REPO_URL,
  STAR_PROMPT_DELAY_MS,
  type StarPromptGuardInput,
  shouldShowStarPrompt,
} from "./star-prompt";

const BASE_GUARD: StarPromptGuardInput = {
  status: { eligible: true, can_snooze: true },
  onboardingCompleted: true,
  hasFocalNotice: false,
  historyAvailable: true,
  windowVisible: true,
  delayElapsed: true,
};

describe("star-prompt core helpers", () => {
  it("exports the exact GitHub URLs and 8-second calm-moment delay", () => {
    expect(GITHUB_REPO_URL).toBe("https://github.com/steamfield/statglass");
    expect(GITHUB_ISSUES_URL).toBe(
      "https://github.com/steamfield/statglass/issues"
    );
    expect(STAR_PROMPT_DELAY_MS).toBe(8_000);
  });

  it("shows the prompt only when every calm-moment guard passes", () => {
    expect(shouldShowStarPrompt(BASE_GUARD)).toBe(true);
    expect(
      shouldShowStarPrompt({
        ...BASE_GUARD,
        status: { eligible: true, can_snooze: false },
      })
    ).toBe(true);
  });

  it("suppresses the prompt when status is missing or ineligible", () => {
    expect(shouldShowStarPrompt({ ...BASE_GUARD, status: null })).toBe(false);
    expect(shouldShowStarPrompt({ ...BASE_GUARD, status: undefined })).toBe(
      false
    );
    expect(
      shouldShowStarPrompt({
        ...BASE_GUARD,
        status: { eligible: false, can_snooze: true },
      })
    ).toBe(false);
  });

  it("suppresses the prompt when any view guard fails", () => {
    expect(
      shouldShowStarPrompt({ ...BASE_GUARD, onboardingCompleted: false })
    ).toBe(false);
    expect(shouldShowStarPrompt({ ...BASE_GUARD, hasFocalNotice: true })).toBe(
      false
    );
    expect(
      shouldShowStarPrompt({ ...BASE_GUARD, historyAvailable: false })
    ).toBe(false);
    expect(shouldShowStarPrompt({ ...BASE_GUARD, windowVisible: false })).toBe(
      false
    );
    expect(shouldShowStarPrompt({ ...BASE_GUARD, delayElapsed: false })).toBe(
      false
    );
  });

  it("formats non-PII system diagnostics cleanly across macOS and partial fields", () => {
    expect(
      formatSystemDiagnostics({
        appVersion: "0.12.1",
        osVersion: "15.4",
        chip: "Apple M4 Pro",
        model: "Mac16,8",
      })
    ).toBe("StatGlass v0.12.1 · macOS 15.4 · Apple M4 Pro");

    expect(
      formatSystemDiagnostics({
        appVersion: "v0.12.1",
        osVersion: "macOS 15.4",
        chip: null,
        model: "Mac16,8",
      })
    ).toBe("StatGlass v0.12.1 · macOS 15.4 · Mac16,8");

    expect(
      formatSystemDiagnostics({
        appVersion: "0.12.1",
        osVersion: "Linux 6.12",
        chip: " ",
        model: "",
      })
    ).toBe("StatGlass v0.12.1 · Linux 6.12");

    expect(
      formatSystemDiagnostics({
        appVersion: "V0.12.1\r\n",
        osVersion: "  MACOS 15.4\n",
        chip: "  Apple M4 Pro\r\n",
        model: "Mac16,8",
      })
    ).toBe("StatGlass v0.12.1 · MACOS 15.4 · Apple M4 Pro");

    expect(
      formatSystemDiagnostics({
        appVersion: "0.12.1",
        osVersion: null,
        chip: undefined,
        model: null,
      })
    ).toBe("StatGlass v0.12.1");
  });
});
