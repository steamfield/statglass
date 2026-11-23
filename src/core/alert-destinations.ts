/**
 * Labels and defaults for alert destinations, for the Alerts page's "Send to"
 * panel and the destination dialog. Pure, no React. A row never shows a full
 * secret: addresses are cut to the server host and a short topic prefix.
 */
import type { DeliveryRecord, Destination } from "@core/generated/bindings";

/** How much of an ntfy topic a row shows before the ellipsis. */
const SHOWN_TOPIC_CHARS = 4;
/** The schemes Rust accepts, in lower case only. */
const URL_SCHEMES = ["http://", "https://"] as const;
/** What ends a URL's authority. */
const AUTHORITY_END = /[/?#]/;
/** A bracket anywhere but around an IPv6 literal. */
const BRACKET = /[[\]]/;
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
 * A short address that tells destination rows apart without showing the
 * secret parts. For ntfy it is the server's host, "/" and the topic's first 4
 * characters with an ellipsis ("ntfy.sh/stat…"), or the host alone when the
 * topic is 4 characters or fewer. For a webhook it is the URL's host only,
 * never its port, credentials, path or query. A webhook host can itself
 * identify the endpoint for some providers. Empty when no host can be read.
 */
export function destinationAddress(d: Destination): string {
  if (d.kind.type === "webhook") return urlHost(d.kind.url);
  const topicChars = [...d.kind.topic];
  const host = urlHost(d.kind.server);
  if (topicChars.length <= SHOWN_TOPIC_CHARS) return host;
  return `${host}/${topicChars.slice(0, SHOWN_TOPIC_CHARS).join("")}…`;
}

/**
 * The host of an `http://` or `https://` URL (lower-case scheme, as Rust
 * accepts), with brackets kept around an IPv6 literal. Empty when the scheme
 * is not one of those, the authority carries a user name or password, or a
 * bracket is out of place. Parsed by hand rather than with `URL`, which
 * throws on the empty address of a destination still being filled in.
 */
function urlHost(url: string): string {
  const scheme = URL_SCHEMES.find((s) => url.startsWith(s));
  if (scheme === undefined) return "";
  const authority = url.slice(scheme.length).split(AUTHORITY_END, 1)[0] ?? "";
  if (authority.includes("@")) return "";
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    return close === -1 ? "" : authority.slice(0, close + 1);
  }
  if (BRACKET.test(authority)) return "";
  return authority.split(":", 1)[0] ?? "";
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
