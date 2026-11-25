import type { CommandError } from "../generated/types";
import type { CommandResult, PhoneQueries, Transport } from "../transport";
import { CommandFailure } from "../transport";
import type { MockTransport } from "./contracts";
import { fail } from "./protocol";

type Methods = Transport & PhoneQueries;
type KeysReturning<Reply> = {
  [Key in keyof Methods]: Methods[Key] extends (...args: never[]) => Reply
    ? Key
    : never;
}[keyof Methods];
type MethodKey = KeysReturning<unknown>;
type RawReplyKey = Exclude<
  MethodKey,
  KeysReturning<Promise<CommandResult<unknown>>>
>;
type SyncKey = Exclude<MethodKey, KeysReturning<Promise<unknown>>>;
type SubscriptionKey = KeysReturning<
  Promise<{
    info: CommandResult<unknown>;
    unsubscribe: () => void;
  }>
>;

const syncReplies = {
  windowLabel: true,
  onNavigateRequested: true,
  onSettingsChanged: true,
  onCapabilitiesChanged: true,
  onHostsChanged: true,
  onHistoryHealthChanged: true,
  onEventRecorded: true,
  onWindowAppearanceChanged: true,
  onWindowVisibility: true,
  onRemoteHostsChanged: true,
  onUpdateStatusChanged: true,
  onStarPromptChanged: true,
  onAlertDestinationsChanged: true,
} satisfies Record<SyncKey, true>;

const subscriptionReplies = {
  subscribeLive: true,
  dockerSubscribe: true,
  dockerLogs: true,
} satisfies Record<SubscriptionKey, true>;

const rawReplies = {
  ...syncReplies,
  ...subscriptionReplies,
  listHosts: true,
  listRemoteHosts: true,
  localRrJob: true,
  getSettings: true,
  getEdition: true,
  getUpdateStatus: true,
  getWindowAppearance: true,
  getStarPromptStatus: true,
  getAlertDestinations: true,
  setPaused: true,
  reportPopoverContentHeight: true,
  processSignal: true,
  openUrl: true,
  closeWindow: true,
  windowVisible: true,
} satisfies Record<RawReplyKey, true>;

function failureReply(method: string, error: CommandError) {
  if (Object.hasOwn(syncReplies, method)) {
    throw new CommandFailure(error);
  }
  if (Object.hasOwn(subscriptionReplies, method)) {
    return Promise.resolve({ info: fail(error), unsubscribe: () => {} });
  }
  if (Object.hasOwn(rawReplies, method)) {
    return Promise.reject(new CommandFailure(error));
  }
  return Promise.resolve(fail(error));
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
