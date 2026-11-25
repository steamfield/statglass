import { commandError, commandErrorText } from "./command-error";

export function rulesConnectionLost(error: unknown): boolean {
  const kind = commandError(error)?.kind;
  return kind === "remote_unreachable" || kind === "remote_busy";
}

export function rulesAgentUnsupported(error: unknown): boolean {
  const kind = commandError(error)?.kind;
  return kind === "remote_unsupported" || kind === "remote_incompatible";
}

export function rulesDisconnectedText(name: string): string {
  return `${name} is not connected`;
}

export function rulesChangedText(name: string): string {
  return `The rules on ${name} changed. Reload them and try again.`;
}

export function remoteRulesErrorText(
  error: unknown,
  name: string,
  fallback: string
): string {
  if (rulesConnectionLost(error)) return rulesDisconnectedText(name);
  if (commandError(error)?.kind === "remote_rules_changed")
    return rulesChangedText(name);
  return commandErrorText(error, fallback);
}

const RULES_RELOADED = {
  save: "The latest rules are loaded; save again to apply your edit.",
  delete: "The latest rules are loaded. Click Delete again to remove the rule.",
  toggle: "The latest rules are loaded. Use the switch to change the rule.",
};

export type RulesWriteAction = keyof typeof RULES_RELOADED;

export function remoteRulesWriteErrorText(
  error: unknown,
  name: string,
  action: RulesWriteAction,
  refreshed: boolean
): string | null {
  if (rulesConnectionLost(error)) return null;
  if (commandError(error)?.kind === "remote_rules_changed") {
    return refreshed
      ? `The rules on ${name} changed. ${RULES_RELOADED[action]}`
      : null;
  }
  return remoteRulesErrorText(error, name, "Couldn't save the rules.");
}
