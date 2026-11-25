import type { CommandError } from "../generated/types";
import type { PhoneQueries, Transport } from "../transport";
import { CommandFailure } from "../transport";
import type { MockTransport } from "./contracts";
import { fail } from "./protocol";

const rawReplies: ReadonlySet<string> = new Set<keyof Transport>([
  "listHosts",
  "listRemoteHosts",
  "localRrJob",
  "getSettings",
  "getEdition",
  "getUpdateStatus",
  "getWindowAppearance",
  "getStarPromptStatus",
  "getAlertDestinations",
  "setPaused",
  "reportPopoverContentHeight",
  "processSignal",
  "openUrl",
  "closeWindow",
  "windowVisible",
]);

function failureReply(method: string, error: CommandError) {
  if (method === "windowLabel" || method.startsWith("on")) {
    throw new CommandFailure(error);
  }
  if (rawReplies.has(method)) {
    return Promise.reject(new CommandFailure(error));
  }
  const reply = fail(error);
  if (
    method === "subscribeLive" ||
    method === "dockerSubscribe" ||
    method === "dockerLogs"
  ) {
    return Promise.resolve({ info: reply, unsubscribe: () => {} });
  }
  return Promise.resolve(reply);
}

export function withFailures(
  transport: Omit<MockTransport, "failNext">
): MockTransport {
  const queued = new Map<string, CommandError[]>();
  for (const [method, call] of Object.entries(transport)) {
    if (typeof call !== "function") continue;
    Reflect.set(transport, method, (...args: unknown[]) => {
      const failures = queued.get(method);
      const error = failures?.shift();
      if (!error) return Reflect.apply(call, transport, args);
      if (failures?.length === 0) queued.delete(method);
      return failureReply(method, error);
    });
  }
  return Object.assign(transport, {
    failNext(
      method: keyof Transport | keyof PhoneQueries,
      error: CommandError
    ) {
      const failures = queued.get(method);
      if (failures) failures.push(error);
      else queued.set(method, [error]);
    },
  });
}
