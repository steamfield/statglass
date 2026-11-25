import { expect, test } from "@jest/globals";
import {
  initialLockState,
  isLockCovered,
  type LockEvent,
  type LockState,
  nextLockState,
} from "@/lock/lock-state";

const active = { type: "app-state", phase: "active" } as const;
const inactive = { type: "app-state", phase: "inactive" } as const;
const background = { type: "app-state", phase: "background" } as const;
const started = { type: "prompt-started" } as const;
const unlocked = { type: "prompt-resolved", result: "unlocked" } as const;
const enable = { type: "enabled", enabled: true } as const;

type Expected = Partial<LockState> & { covered?: boolean };
interface LockCase {
  name: string;
  starts: [enabled: boolean, phase: LockState["phase"]];
  initial: Expected;
  steps: [LockEvent, Expected][];
}

const cases: LockCase[] = [
  {
    name: "launches covered and queues the first unlock when active",
    starts: [true, "inactive"],
    initial: { mode: "locked", prompt: "idle", covered: true },
    steps: [[active, { prompt: "queued", covered: true }]],
  },
  {
    name: "backgrounding during a prompt waits for that prompt to finish",
    starts: [true, "active"],
    initial: { prompt: "queued", covered: true },
    steps: [
      [started, { prompt: "running" }],
      [background, { prompt: "stale", covered: true }],
      [active, { prompt: "stale", covered: true }],
    ],
  },
  {
    name: "a late success after backgrounding queues another unlock",
    starts: [true, "active"],
    initial: { mode: "locked", covered: true },
    steps: [
      [started, { prompt: "running" }],
      [inactive, { prompt: "running", covered: true }],
      [background, { prompt: "stale", covered: true }],
      [active, { prompt: "stale", covered: true }],
      [unlocked, { mode: "locked", prompt: "queued", covered: true }],
      [started, { prompt: "running" }],
      [unlocked, { mode: "unlocked", prompt: "idle", covered: false }],
    ],
  },
  {
    name: "cancelling a prompt leaves the lock visible without a second automatic prompt",
    starts: [true, "active"],
    initial: { prompt: "queued" },
    steps: [
      [started, { prompt: "running" }],
      [inactive, { covered: true }],
      [
        { type: "prompt-resolved", result: "cancelled" },
        { prompt: "idle", error: false, covered: true },
      ],
      [active, { prompt: "idle", covered: true }],
      [{ type: "request-unlock" }, { prompt: "queued" }],
    ],
  },
  {
    name: "enabling while the settings prompt dismisses skips just that resume",
    starts: [false, "active"],
    initial: { mode: "disabled", covered: false },
    steps: [
      [inactive, { phase: "inactive", covered: false }],
      [enable, { mode: "enabling-resume", prompt: "idle", covered: false }],
      [active, { mode: "unlocked", prompt: "idle", covered: false }],
      [inactive, { mode: "locked", prompt: "idle", covered: true }],
      [active, { mode: "locked", prompt: "queued", covered: true }],
    ],
  },
  {
    name: "going to the background after enabling still requires an unlock",
    starts: [false, "inactive"],
    initial: { covered: false },
    steps: [
      [enable, { covered: false }],
      [background, { mode: "locked", covered: true }],
      [active, { prompt: "queued", covered: true }],
    ],
  },
  {
    name: "disabling invalidates an outstanding prompt and removes the cover",
    starts: [true, "active"],
    initial: { covered: true },
    steps: [
      [started, { prompt: "running" }],
      [
        { type: "enabled", enabled: false },
        { mode: "disabled", prompt: "stale", covered: false },
      ],
      [unlocked, { mode: "disabled", prompt: "idle", covered: false }],
    ],
  },
];

test.each(cases)("$name", ({ starts, initial, steps }) => {
  let state = initialLockState(...starts);
  expect({ ...state, covered: isLockCovered(state) }).toMatchObject(initial);
  for (const [event, expected] of steps) {
    state = nextLockState(state, event);
    expect({ ...state, covered: isLockCovered(state) }).toMatchObject(expected);
  }
});
