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
import {
  ALERT_DESTINATION_LIMITS,
  type AlertDestinationsView,
  type DeliveryOutcome,
  type Destination,
  type DestinationKind,
} from "@core/generated/bindings";
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
const URL_SCHEMES = ["http://", "https://"] as const;
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
      // Replacing keeps the row's place and its last delivery.
      return ok(
        this.commit(
          rows.map((row) =>
            row.destination.id === saved.id
              ? { ...row, destination: saved }
              : row
          )
        )
      );
    }
    if (rows.length >= LIMITS.max_destinations) {
      return invalid(
        `at most ${LIMITS.max_destinations} destinations can be saved`
      );
    }
    return ok(this.commit([...rows, { destination: saved, last: null }]));
  };
  /** As `AlertsService::delete`: an unknown id is `invalid_argument`. */
  readonly deleteAlertDestination: MockTransport["deleteAlertDestination"] =
    async (id) => {
      this.commands.record("alert_destination_delete", id);
      const rows = this.view.destinations;
      if (!rows.some((row) => row.destination.id === id)) {
        return invalid(`no destination has id ${id}`);
      }
      return ok(this.commit(rows.filter((row) => row.destination.id !== id)));
    };
  /** As `alert_destination_test`: validates, sends nothing real, records nothing. */
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
  if (!validUrl(kind.server)) return MESSAGES.url;
  if (!validTopic(kind.topic)) return MESSAGES.topic;
  return validToken(kind.token) ? null : MESSAGES.token;
}

/** 1 to `max_name_chars` characters once Rust's `str::trim` has run. */
function validName(name: string): boolean {
  const chars = charCount(name.replace(EDGE_WHITESPACE, ""));
  return chars > 0 && chars <= LIMITS.max_name_chars;
}

/**
 * An `http://` or `https://` URL of at most `max_url_chars` characters that
 * names a host and holds no whitespace, control character, quote or
 * backslash.
 */
function validUrl(url: string): boolean {
  if (charCount(url) > LIMITS.max_url_chars) return false;
  if (SPACE_OR_CONTROL.test(url) || URL_FORBIDDEN.test(url)) return false;
  const scheme = URL_SCHEMES.find((s) => url.startsWith(s));
  if (scheme === undefined) return false;
  return hostOf(url.slice(scheme.length)) !== "";
}

/** The host in what follows a URL's scheme: no credentials, port or path. */
function hostOf(afterScheme: string): string {
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? "";
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  return hostAndPort.replace(/:\d*$/, "");
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
