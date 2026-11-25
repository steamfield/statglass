/**
 * Demo mode's transport: the shared mock transport running the hosts
 * dashboard scenario (a local Mac plus remote Macs and Linux servers in
 * live, connecting and offline states), the same one the desktop tests use.
 */
import { createMockTransport } from "@core/mock-transport";
import type { PhoneTransport } from "./seam";

/** A fresh demo transport; each call starts its own mock hosts. */
export function createDemoTransport(): PhoneTransport {
  return createMockTransport({ scenarios: ["hosts-dashboard"] });
}
