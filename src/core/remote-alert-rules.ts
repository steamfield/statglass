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
