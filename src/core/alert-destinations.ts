/**
 * Labels and defaults for alert destinations, for the Alerts page's "Send to"
 * panel and the destination dialog. Pure, no React. A row never shows a full
 * secret: addresses are cut to the server host and a topic prefix.
 */
import type { DeliveryRecord, Destination } from "@core/generated/bindings";

/**
 * Where a destination sends, safe to show in a row: the ntfy server's host and
 * the topic's first 14 characters with an ellipsis when longer
 * ("ntfy.sh/statglass-4f2a…"), or a webhook URL's host only.
 */
export function destinationAddress(d: Destination): string {
  void d;
  throw new Error("not implemented");
}

/**
 * The last delivery as a row label at `timeOf(at_ms)`: "Delivered 14:02", or
 * "Failed 14:02 · <detail>" ("Failed 14:02 · HTTP 403"). Null before any
 * delivery.
 */
export function deliveryLabel(
  record: DeliveryRecord | null,
  timeOf: (ms: number) => string
): string | null {
  void record;
  void timeOf;
  throw new Error("not implemented");
}

/**
 * A fresh, hard-to-guess ntfy topic: "statglass-" and 20 lowercase base32
 * characters drawn from `random(n)` (n random bytes).
 */
export function generateTopic(random: (n: number) => Uint8Array): string {
  void random;
  throw new Error("not implemented");
}

/**
 * A new, enabled destination of `kind` with id `id`, as the dialog starts it:
 * ntfy on https://ntfy.sh with no topic or token yet, or a webhook with no URL.
 */
export function newDestination(
  kind: "ntfy" | "webhook",
  id: string
): Destination {
  void kind;
  void id;
  throw new Error("not implemented");
}
