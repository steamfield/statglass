import type { PairingFailure } from "./generated/types";
import {
  failureReason,
  pairingAdvice,
  remoteErrorAdvice,
  remoteErrorText,
  remoteQueryText,
  sshTestCommand,
  sshVerificationCommand,
} from "./remote-errors";
import { CommandFailure } from "./transport/query";

it("words a failure's reason as a sentence, typed or not", () => {
  expect(
    failureReason(new CommandFailure({ kind: "unknown_host", host: "h" }), "x")
  ).toBe("This host is no longer in your host list.");
  expect(failureReason({ kind: "remote_host", host: "h" }, "x")).toBe(
    "This host does not share this data."
  );
  expect(failureReason({ kind: "store", message: "Locked." }, "x")).toBe(
    "Locked."
  );
  expect(failureReason(new Error("ipc closed"), "Try again.")).toBe(
    "ipc closed"
  );
  expect(failureReason(undefined, "Try again.")).toBe("Try again.");
});

it("keeps shell syntax inside a quoted SSH destination", () => {
  expect(sshTestCommand("o'brien@$(whoami)")).toBe(
    "/usr/bin/ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -o ControlPath=none -- 'o'\\''brien@$(whoami)' true"
  );
  for (const input of ["ssh studio", "-Fconfig", "studio\nother", ""]) {
    expect(sshTestCommand(input)).toBeNull();
  }
});

it("allows host confirmation only in the interactive verification command", () => {
  expect(sshVerificationCommand("o'brien@$(whoami)")).toBe(
    "/usr/bin/ssh -o BatchMode=no -o StrictHostKeyChecking=ask -o ConnectTimeout=5 -o ControlPath=none -- 'o'\\''brien@$(whoami)' true"
  );
  for (const input of ["ssh studio", "-Fconfig", "studio\nother", ""]) {
    expect(sshVerificationCommand(input)).toBeNull();
  }
});

it("words why a connected host did not answer a query apart from a dropped one", () => {
  const text = (
    kind: "remote_busy" | "remote_unsupported" | "remote_unreachable"
  ) =>
    remoteQueryText(new CommandFailure({ kind, message: "" }), "space reports");
  expect(text("remote_busy")).toBe(
    "This host is busy or slow to answer, so its space reports can't be read now. Try again in a moment."
  );
  expect(text("remote_unsupported")).toBe(
    "This host doesn't offer space reports."
  );
  expect(text("remote_unreachable")).toBe(
    "This host isn't connected, so its space reports can't be read now."
  );
  expect(remoteQueryText(new Error("other"), "space reports")).toBeNull();
});

const pairingCopy = {
  denied: [
    "The host declined the pairing request.",
    "Start pairing again on Build host. Compare the codes before approving.",
  ],
  expired: ["The pairing code expired.", "Ask for a new code on Build host."],
  used: [
    "The pairing code has already been used.",
    "Ask for a new code on Build host.",
  ],
  unknown: [
    "The host does not recognize this pairing code.",
    "Start pairing again on Build host.",
  ],
  unavailable: [
    "Pairing is unavailable on this host.",
    "Check StatGlass is running on Build host, then start pairing again.",
  ],
  monitoring_off: [
    "Remote monitoring is off on this host.",
    "Turn on remote monitoring on Build host, then start pairing again.",
  ],
  invalid: [
    "The pairing data is invalid.",
    "Scan the QR again or paste the entire pairing code.",
  ],
} as const satisfies Record<PairingFailure, readonly [string, string]>;

it.each(Object.entries(pairingCopy))(
  "uses the %s title and offers phone recovery despite a host detail",
  (reason, [title, recovery]) => {
    const error = {
      kind: "pairing",
      reason: reason as PairingFailure,
      message: "Diagnostic from the host.",
    } as const;
    expect(remoteErrorText(error)).toBe(title);
    expect(pairingAdvice(error, "Build host")).toEqual({ title, recovery });
  }
);

it.each([
  [
    "host_key_unknown",
    "The host key doesn’t match the pairing code.",
    "Start pairing again on Build host. Use a code from the host you want to add.",
  ],
  [
    "remote_unreachable",
    "StatGlass couldn’t reach the host.",
    "Check Build host is reachable on this network, then try again.",
  ],
  [
    "remote_auth",
    "The host refused the pairing key.",
    "Start pairing again on Build host.",
  ],
] as const)(
  "gives pairing-specific wording for %s",
  (kind, title, recovery) => {
    expect(
      pairingAdvice({ kind, message: "SSH detail" }, "Build host")
    ).toEqual({ title, recovery });
  }
);

it.each([
  [
    "remote_not_running",
    "StatGlass isn’t running on the other Mac",
    "Open StatGlass on",
  ],
  [
    "remote_monitoring_off",
    "Remote monitoring is off on the other Mac",
    "Turn on Allow remote monitoring in StatGlass Settings on",
  ],
] as const)("gives targeted recovery for %s", (kind, title, recovery) => {
  const error = { kind, message: "" };
  expect(remoteErrorAdvice(error)).toEqual({
    title,
    recovery: `${recovery} the other Mac, then retry.`,
  });
  expect(remoteQueryText(error, "space reports")).toBe(
    `${recovery} this Mac host, then retry.`
  );
});
