import {
  failureReason,
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

it.each([
  ["denied", "The host declined the pairing request."],
  ["expired", "The pairing code expired."],
  ["used", "The pairing code has already been used."],
  ["unknown", "The host does not recognize this pairing code."],
  ["unavailable", "Pairing is unavailable on this host."],
  ["invalid", "The pairing data is invalid."],
] as const)(
  "words a %s pairing failure when the host gives no details",
  (reason, copy) => {
    expect(remoteErrorText({ kind: "pairing", reason, message: "" })).toBe(
      copy
    );
  }
);

it("keeps the host's pairing setup guidance", () => {
  const message = "Turn on Allow remote monitoring in StatGlass Settings.";
  expect(
    remoteErrorText({ kind: "pairing", reason: "unavailable", message })
  ).toBe(message);
});

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
