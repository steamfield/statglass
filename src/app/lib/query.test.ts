import {
  appKeys,
  diskSpaceKeys,
  dockerKeys,
  historyKeys,
  hostKeys,
} from "@core/query-keys";
import { expect, it } from "vitest";
import { makeQueryClient, shouldRetry } from "./query";

it("never retries the polled and one-shot families", () => {
  const client = makeQueryClient();
  const retry = (queryKey: readonly unknown[]) =>
    client.defaultQueryOptions({ queryKey }).retry;
  expect(retry(diskSpaceKeys.volumes("h"))).toBe(false);
  expect(retry(diskSpaceKeys.subtree("h", 1, null, false))).toBe(false);
  expect(retry(dockerKeys.storage("e", 0))).toBe(false);
  expect(retry(dockerKeys.operation("e"))).toBe(false);
  expect(retry(appKeys.publicIp("en0", "10.0.0.2", null))).toBe(false);
  expect(retry(appKeys.appearance)).toBe(false);
  expect(retry(hostKeys.sshConfig())).toBe(false);
});

it("leaves history and everything else on the error-kind policy", () => {
  const client = makeQueryClient();
  const retry = (queryKey: readonly unknown[]) =>
    client.defaultQueryOptions({ queryKey }).retry;
  expect(retry(historyKeys.events("h", 1, null))).toBe(shouldRetry);
  expect(retry(dockerKeys.history("h", "e", null, 0, 1, 0))).toBe(shouldRetry);
  expect(retry(appKeys.edition)).toBe(shouldRetry);
});
