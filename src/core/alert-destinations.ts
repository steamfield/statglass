/**
 * Labels and defaults for alert destinations, for the Alerts page's "Send to"
 * panel and the destination dialog. Pure, no React. A row never shows a full
 * secret: addresses are cut to the server host and a topic prefix.
 */
import type { DeliveryRecord, Destination } from "@core/generated/bindings";

/** How much of an ntfy topic a row shows before the ellipsis. */
const SHOWN_TOPIC_CHARS = 14;
/** The public ntfy server a new ntfy destination starts on. */
const DEFAULT_NTFY_SERVER = "https://ntfy.sh";
/** What every generated topic starts with, so the user can tell it is ours. */
const TOPIC_PREFIX = "statglass-";
/** Random characters after the prefix: 100 bits, too many to guess. */
const TOPIC_RANDOM_CHARS = 20;
/** RFC 4648 base32 in lowercase, which ntfy topics and URLs carry as is. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BITS_PER_BASE32_CHAR = 5;
const BITS_PER_BYTE = 8;

/**
 * Where a destination sends, safe to show in a row: the ntfy server's host and
 * the topic's first 14 characters with an ellipsis when longer
 * ("ntfy.sh/statglass-4f2a…"), or a webhook URL's host only.
 */
export function destinationAddress(d: Destination): string {
  if (d.kind.type === "webhook") return urlHost(d.kind.url);
  return `${urlHost(d.kind.server)}/${shortTopic(d.kind.topic)}`;
}

/**
 * The host (and port, when given) of an http(s) URL, without its scheme,
 * credentials, path, query or fragment. Parsed by hand rather than with
 * `URL`, which throws on the empty address of a destination still being
 * filled in.
 */
function urlHost(url: string): string {
  const afterScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? "";
  return authority.slice(authority.lastIndexOf("@") + 1);
}

/** The topic's first characters, with an ellipsis when some were cut. */
function shortTopic(topic: string): string {
  const chars = [...topic];
  if (chars.length <= SHOWN_TOPIC_CHARS) return topic;
  return `${chars.slice(0, SHOWN_TOPIC_CHARS).join("")}…`;
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
  if (record === null) return null;
  const time = timeOf(record.at_ms);
  const outcome = record.outcome;
  if (outcome.kind === "delivered") return `Delivered ${time}`;
  return `Failed ${time} · ${outcome.detail}`;
}

/**
 * A fresh, hard-to-guess ntfy topic: "statglass-" and 20 lowercase base32
 * characters drawn from `random(n)` (n random bytes).
 */
export function generateTopic(random: (n: number) => Uint8Array): string {
  const bitsNeeded = TOPIC_RANDOM_CHARS * BITS_PER_BASE32_CHAR;
  const bytes = random(Math.ceil(bitsNeeded / BITS_PER_BYTE));
  return TOPIC_PREFIX + base32(bytes).slice(0, TOPIC_RANDOM_CHARS);
}

/**
 * `bytes` as lowercase RFC 4648 base32, whole characters only: bits left over
 * at the end (fewer than five) are dropped rather than padded.
 */
function base32(bytes: Uint8Array): string {
  const lowBitsMask = (1 << BITS_PER_BASE32_CHAR) - 1;
  let out = "";
  let buffer = 0;
  let buffered = 0;
  for (const byte of bytes) {
    buffer = (buffer << BITS_PER_BYTE) | byte;
    buffered += BITS_PER_BYTE;
    while (buffered >= BITS_PER_BASE32_CHAR) {
      buffered -= BITS_PER_BASE32_CHAR;
      out += BASE32_ALPHABET[(buffer >> buffered) & lowBitsMask];
    }
    // Keep only the bits not yet written, so the buffer never overflows.
    buffer &= (1 << buffered) - 1;
  }
  return out;
}

/**
 * A new, enabled destination of `kind` with id `id`, as the dialog starts it:
 * ntfy on https://ntfy.sh with no topic or token yet, or a webhook with no URL.
 * The name is empty for the user to fill in.
 */
export function newDestination(
  kind: "ntfy" | "webhook",
  id: string
): Destination {
  const base = { id, name: "", enabled: true };
  if (kind === "webhook") {
    return { ...base, kind: { type: "webhook", url: "" } };
  }
  return {
    ...base,
    kind: {
      type: "ntfy",
      server: DEFAULT_NTFY_SERVER,
      topic: "",
      token: null,
    },
  };
}
