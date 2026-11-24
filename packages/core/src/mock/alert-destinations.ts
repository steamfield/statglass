/**
 * The mock transport's alert destinations: the four `alert_destination*`
 * commands and the `alert-destinations-changed` event, behaving as Rust's
 * `AlertsService` does (validation, at most 8, replace by id, the last
 * delivery per destination). The `alert-delivery-fails` scenario makes every
 * test delivery fail.
 *
 * Every limit and rejection text comes from `ALERT_DESTINATION_LIMITS`, which
 * Rust publishes from the constants `Destination::validate` reads.
 */
import { sameAddress } from "@core/alert-destinations";
import {
  ALERT_DESTINATION_LIMITS,
  type AlertDestinationsView,
  type DeliveryOutcome,
  type Destination,
  type DestinationKind,
} from "@core/generated/types";
import type { MockCommands } from "./commands";
import type { MockTransport } from "./contracts";
import type { MockEmitters } from "./emitters";
import type { ScenarioFlags } from "./fixtures";
import { invalid, ok } from "./protocol";

const LIMITS = ALERT_DESTINATION_LIMITS;
const MESSAGES = LIMITS.messages;

/** What a test delivery answers when it succeeds (ntfy answers 200). */
const TEST_DELIVERED: DeliveryOutcome = { kind: "delivered", status: 200 };
/** What a test delivery answers in the `alert-delivery-fails` scenario. */
const TEST_FAILED: DeliveryOutcome = {
  kind: "failed",
  reason: "http",
  detail: "HTTP 403",
};

/**
 * What Rust's `char::is_whitespace` counts as whitespace. JS `\s` differs: it
 * also matches U+FEFF and misses U+0085.
 */
const RUST_WHITESPACE =
  "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGE_WHITESPACE = new RegExp(
  `^[${RUST_WHITESPACE}]+|[${RUST_WHITESPACE}]+$`,
  "g"
);
/** Whitespace or a control character (Rust's `char::is_control`, Unicode Cc). */
const SPACE_OR_CONTROL = new RegExp(`[${RUST_WHITESPACE}\\p{Cc}]`, "u");
/** What a URL may not hold beyond whitespace and control characters. */
const URL_FORBIDDEN = /["\\]/;
/** Matched in lower case only, as Rust does. */
const URL_SCHEMES = ["http://", "https://"] as const;
/** What ends a URL's authority. */
const AUTHORITY_END = /[/?#]/;
/** A port: 1 to 5 ASCII digits. */
const PORT = /^[0-9]{1,5}$/;
/** A host needs one character that is not a dot or a hyphen. */
const HOST_CHAR = /[^.-]/;
/** A bracket outside the leading one of an IPv6 literal. */
const BRACKET = /[[\]]/;
const TOPIC_CHARS = /^[A-Za-z0-9_-]+$/;

/** Mock owner of the alert destinations, registered by `createMockTransport`. */
export class MockAlertDestinations {
  /** Set by the `alert-delivery-fails` scenario: test deliveries fail. */
  readonly deliveryFails: boolean;
  private view: AlertDestinationsView = { destinations: [], load_error: null };
  constructor(
    private readonly commands: MockCommands,
    private readonly emitters: MockEmitters,
    flags: ScenarioFlags
  ) {
    this.deliveryFails = flags.alertDeliveryFails;
  }
  readonly getAlertDestinations: MockTransport["getAlertDestinations"] =
    async () => {
      this.commands.record("alert_destinations_get");
      return structuredClone(this.view);
    };
  /** As `AlertsService::save`: validates, then replaces by id or appends. */
  readonly saveAlertDestination: MockTransport["saveAlertDestination"] = async (
    destination
  ) => {
    this.commands.record("alert_destination_save", destination);
    const problem = destinationProblem(destination);
    if (problem !== null) return invalid(problem);
    const rows = this.view.destinations;
    const saved = structuredClone(destination);
    const known = rows.some((row) => row.destination.id === saved.id);
    if (known) {
      // Replacing keeps the row's place; the last delivery stays only while
      // the address is the same, as Rust's `AlertsService::save` does.
      return ok(
        this.commit(
          rows.map((row) =>
            row.destination.id === saved.id
              ? {
                  destination: saved,
                  last: sameAddress(row.destination.kind, saved.kind)
                    ? row.last
                    : null,
                }
              : row
          )
        )
      );
    }
    if (rows.length >= LIMITS.max_destinations) {
      return invalid(MESSAGES.too_many);
    }
    return ok(this.commit([...rows, { destination: saved, last: null }]));
  };
  /** As `AlertsService::delete`: an unknown id is `invalid_argument`. */
  readonly deleteAlertDestination: MockTransport["deleteAlertDestination"] =
    async (id) => {
      this.commands.record("alert_destination_delete", id);
      const rows = this.view.destinations;
      if (!rows.some((row) => row.destination.id === id)) {
        return invalid(MESSAGES.unknown_id);
      }
      return ok(this.commit(rows.filter((row) => row.destination.id !== id)));
    };
  /**
   * As `alert_destination_test`: validates and sends nothing real. A test
   * never becomes a destination's `last` delivery, saved or not, because
   * Rust's `dispatch::send_test` records nothing.
   */
  readonly testAlertDestination: MockTransport["testAlertDestination"] = async (
    destination
  ) => {
    this.commands.record("alert_destination_test", destination);
    const problem = destinationProblem(destination);
    if (problem !== null) return invalid(problem);
    return ok(
      structuredClone(this.deliveryFails ? TEST_FAILED : TEST_DELIVERED)
    );
  };
  readonly onAlertDestinationsChanged: MockTransport["onAlertDestinationsChanged"] =
    (cb) => this.emitters.alertDestinations.on(cb);

  /** Stores `destinations` as the new list, emits it, and returns a copy. */
  private commit(
    destinations: AlertDestinationsView["destinations"]
  ): AlertDestinationsView {
    this.view = { ...this.view, destinations };
    this.emitters.alertDestinations.emit(structuredClone(this.view));
    return structuredClone(this.view);
  }

  get methods() {
    return {
      getAlertDestinations: this.getAlertDestinations,
      saveAlertDestination: this.saveAlertDestination,
      deleteAlertDestination: this.deleteAlertDestination,
      testAlertDestination: this.testAlertDestination,
      onAlertDestinationsChanged: this.onAlertDestinationsChanged,
    };
  }
}

/**
 * Why Rust's `Destination::validate` would refuse `destination`, as its
 * `DestinationError` text, or null when it accepts it. Checked in Rust's
 * order: name, then address, then topic, then token.
 */
function destinationProblem(destination: Destination): string | null {
  if (!validName(destination.name)) return MESSAGES.name;
  return kindProblem(destination.kind);
}

/** Why Rust would refuse a destination's address, topic or token, or null. */
function kindProblem(kind: DestinationKind): string | null {
  if (kind.type === "webhook") return validUrl(kind.url) ? null : MESSAGES.url;
  if (!validNtfyServer(kind.server)) return MESSAGES.url;
  if (!validTopic(kind.topic)) return MESSAGES.topic;
  return validToken(kind.token) ? null : MESSAGES.token;
}

/**
 * 1 to `max_name_chars` characters that Rust's `str::trim` leaves as they
 * are: a name with leading or trailing whitespace is refused.
 */
function validName(name: string): boolean {
  if (name.replace(EDGE_WHITESPACE, "") !== name) return false;
  const chars = charCount(name);
  return chars > 0 && chars <= LIMITS.max_name_chars;
}

/**
 * A valid URL with no query or fragment: the request goes to `<server>/`, so
 * either would end up in front of that slash.
 */
function validNtfyServer(server: string): boolean {
  return validUrl(server) && !server.includes("?") && !server.includes("#");
}

/**
 * An `http://` or `https://` URL (lower case) of at most `max_url_chars`
 * characters with a valid authority, holding no whitespace, control
 * character, quote or backslash.
 */
function validUrl(url: string): boolean {
  if (charCount(url) > LIMITS.max_url_chars) return false;
  if (SPACE_OR_CONTROL.test(url) || URL_FORBIDDEN.test(url)) return false;
  const scheme = URL_SCHEMES.find((s) => url.startsWith(s));
  if (scheme === undefined) return false;
  const authority = url.slice(scheme.length).split(AUTHORITY_END, 1)[0] ?? "";
  return validAuthority(authority);
}

/**
 * A host with an optional port of 1 to 5 digits and no user name or password
 * (no `@`). The host needs a character other than `.` and `-`.
 */
function validAuthority(authority: string): boolean {
  if (authority.includes("@")) return false;
  const parts = hostAndPort(authority);
  if (parts === null) return false;
  const portIsValid = parts.port === null || PORT.test(parts.port);
  return HOST_CHAR.test(parts.host) && portIsValid;
}

/**
 * `authority` split into host and optional port, or null when a bracket is
 * unclosed, stray, or followed by anything but a port. Brackets only enclose
 * an IPv6 literal (`[::1]:8080`).
 */
function hostAndPort(
  authority: string
): { host: string; port: string | null } | null {
  if (!authority.startsWith("[")) {
    if (BRACKET.test(authority)) return null;
    const colon = authority.indexOf(":");
    if (colon === -1) return { host: authority, port: null };
    return {
      host: authority.slice(0, colon),
      port: authority.slice(colon + 1),
    };
  }
  const close = authority.indexOf("]");
  if (close === -1) return null;
  const host = authority.slice(1, close);
  if (host.includes("[")) return null;
  const afterHost = authority.slice(close + 1);
  if (afterHost === "") return { host, port: null };
  if (!afterHost.startsWith(":")) return null;
  return { host, port: afterHost.slice(1) };
}

/** 1 to `max_topic_chars` of `[A-Za-z0-9_-]`. */
function validTopic(topic: string): boolean {
  return topic.length <= LIMITS.max_topic_chars && TOPIC_CHARS.test(topic);
}

/**
 * No token, or one of at most `max_token_chars` characters with no
 * whitespace or control character. An empty token counts as none.
 */
function validToken(token: string | null): boolean {
  if (token === null || token === "") return true;
  return (
    charCount(token) <= LIMITS.max_token_chars && !SPACE_OR_CONTROL.test(token)
  );
}

/** Length in characters (Unicode scalar values), as Rust's `chars().count()`. */
function charCount(text: string): number {
  return [...text].length;
}
