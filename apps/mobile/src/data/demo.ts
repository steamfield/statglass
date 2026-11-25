/**
 * Demo mode's transport: the shared mock transport running the hosts
 * dashboard and incompatible-host scenarios the desktop tests use.
 */
import { createMockTransport } from "@core/mock-transport";
import type { PhoneTransport } from "./seam";

/** A fresh demo transport; each call starts its own mock hosts. */
export function createDemoTransport(): PhoneTransport {
  return createMockTransport({
    scenarios: ["hosts-dashboard", "host-incompatible"],
  });
}
