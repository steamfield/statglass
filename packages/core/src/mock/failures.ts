import type { MockTransport } from "./contracts";

export function withFailures(
  transport: Omit<MockTransport, "failNext">
): MockTransport {
  return Object.assign(transport, { failNext() {} });
}
