/**
 * The mock's destination validation against every good and bad row in Rust's
 * `Destination::validate` tests (crates/statglass-schema/src/alert_destination.rs
 * and alert_destination_tests.rs), so the two cannot drift silently. Each
 * refusal must carry the same `ALERT_DESTINATION_LIMITS` message Rust returns.
 */
import {
  ALERT_DESTINATION_LIMITS,
  type Destination,
} from "@core/generated/types";
import { describe, expect, it } from "vitest";
import { createMockTransport } from "../mock-transport";

type Rule = keyof typeof ALERT_DESTINATION_LIMITS.messages;

function ntfy(server: string, topic = "alerts", token: string | null = null) {
  return destination("Phone", { type: "ntfy", server, topic, token });
}

function webhook(url: string) {
  return destination("Team chat", { type: "webhook", url });
}

function named(name: string) {
  return destination(name, {
    type: "ntfy",
    server: "https://ntfy.sh",
    topic: "statglass-4f2a",
    token: null,
  });
}

function destination(name: string, kind: Destination["kind"]): Destination {
  return {
    id: "de570000-0000-4000-8000-000000000001",
    name,
    enabled: true,
    kind,
  };
}

/** An http(s) URL of exactly `len` characters with a host. */
function urlOfLen(len: number): string {
  const base = "https://hooks.example.com/";
  return base + "a".repeat(len - base.length);
}

/** The Rust message the mock refuses `d` with, or null when it saves it. */
async function refusal(d: Destination): Promise<string | null> {
  const result = await createMockTransport().saveAlertDestination(d);
  if (result.status === "ok") return null;
  expect(result.error.kind).toBe("invalid_argument");
  return result.error.kind === "invalid_argument" ? result.error.message : "";
}

const BAD_URLS = [
  "",
  "ntfy.sh",
  "ftp://ntfy.sh",
  "file:///etc/hosts",
  "https://",
  "http:///path",
  "HTTPS//ntfy.sh",
  "javascript:alert(1)",
  urlOfLen(2049),
  "https://hooks.example.com/a b",
  "https://hooks.example.com/a\tb",
  'https://hooks.example.com/a\nurl = "http://evil"',
  "https://hooks.example.com/a\rb",
  "https://hooks.example.com/a\u0007b",
  "https://hooks.example.com/a\u007fb",
  'https://hooks.example.com/a"b',
  "https://hooks.example.com/a\\b",
  " https://hooks.example.com/",
  "https://user@hooks.example.com/x",
  "https://user:secret@hooks.example.com/x",
  "https://@hooks.example.com/",
  "https://user:pa/ss@hooks.example.com/x",
  "http://user:secret@[::1]:8080/x",
  "HTTPS://ntfy.sh",
  "Http://ntfy.sh",
  "hTTps://ntfy.sh/",
  "http://ntfy.local:",
  "http://ntfy.local:port",
  "http://ntfy.local:123456",
  "http://:8080/x",
  "http://[::1/x",
  "http://[::1]x/",
  "http://[]:80/",
  "http://./",
  "http://-/",
  "http://.-./x",
  "http://[::1/secret",
  "http://a[b/",
  "http://ab]/",
  "http://[[::1]/",
];

const CASES: [string, Destination, Rule | null][] = [
  ...["P", "Phone", "My phone", "n".repeat(40)].map(
    (name): [string, Destination, null] => [`name ${name}`, named(name), null]
  ),
  ["name of 40 accented letters", named("é".repeat(40)), null],
  ...[
    "",
    "   ",
    "\t",
    "n".repeat(41),
    "  Phone  ",
    " Phone",
    "Phone\n",
    "Phone ",
    ` ${"n".repeat(40)} `,
  ].map((name): [string, Destination, Rule] => [
    `name ${name}`,
    named(name),
    "name",
  ]),
  ...[
    "https://ntfy.sh",
    "http://ntfy.local:8080",
    "https://ntfy.example.com/",
  ].map((s): [string, Destination, null] => [`server ${s}`, ntfy(s), null]),
  ...[
    "https://chat.example.com/hooks/T0/B0/xyz",
    "http://192.168.1.20:5000/hook?x=1",
    "https://hooks.example.com/a-b_c~d%20e",
    urlOfLen(2048),
    "https://hooks.example.com/@team",
    "https://hooks.example.com/x?to=a@b",
    "http://ntfy.local:8080",
    "http://[::1]:8080/x",
    "http://[::1]/x",
    "http://a-b.c/",
    "https://hooks.example.com/x?a=1#b",
  ].map((u): [string, Destination, null] => [`url ${u}`, webhook(u), null]),
  ...BAD_URLS.flatMap((u): [string, Destination, Rule][] => [
    [`url ${u}`, webhook(u), "url"],
    [`server ${u}`, ntfy(u), "url"],
  ]),
  ...["https://ntfy.sh/?x", "https://ntfy.sh#x", "https://ntfy.sh/a?"].map(
    (s): [string, Destination, Rule] => [`server ${s}`, ntfy(s), "url"]
  ),
  ...["a", "statglass-4f2a", "Mac_Alerts-01", "t".repeat(64)].map(
    (t): [string, Destination, null] => [
      `topic ${t}`,
      ntfy("https://ntfy.sh", t),
      null,
    ]
  ),
  ...[
    "",
    "t".repeat(65),
    "my topic",
    "topic/sub",
    "topic.dot",
    "tópico",
    'a"b',
    "a\nb",
  ].map((t): [string, Destination, Rule] => [
    `topic ${t}`,
    ntfy("https://ntfy.sh", t),
    "topic",
  ]),
  ...["tk_example_0123456789", "k".repeat(256), 'a"b\\c', ""].map(
    (k): [string, Destination, null] => [
      `token ${k}`,
      ntfy("https://ntfy.sh", "alerts", k),
      null,
    ]
  ),
  ["no token", ntfy("https://ntfy.sh", "alerts", null), null],
  ...[
    "k".repeat(257),
    "tk 123",
    "tk\t123",
    "tk\n123",
    "tk\r123",
    "tk\u0000123",
    " tk",
  ].map((k): [string, Destination, Rule] => [
    `token ${k}`,
    ntfy("https://ntfy.sh", "alerts", k),
    "token",
  ]),
];

describe("mock destination validation matches Rust's", () => {
  it.each(CASES)("%j", async (_, d, rule) => {
    const expected =
      rule === null ? null : ALERT_DESTINATION_LIMITS.messages[rule];
    expect(await refusal(d)).toBe(expected);
  });
});

describe("mock destination service messages", () => {
  it("refuses a ninth destination and an unknown id in Rust's words", async () => {
    const t = createMockTransport();
    for (let n = 1; n <= ALERT_DESTINATION_LIMITS.max_destinations; n++) {
      await t.saveAlertDestination({
        ...named(`Phone ${n}`),
        id: `de570000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      });
    }
    expect(
      await t.saveAlertDestination({
        ...named("Phone 9"),
        id: "de570000-0000-4000-8000-000000000009",
      })
    ).toEqual({
      status: "error",
      error: {
        kind: "invalid_argument",
        message: ALERT_DESTINATION_LIMITS.messages.too_many,
      },
    });
    expect(
      await t.deleteAlertDestination("de570000-0000-4000-8000-0000000000ff")
    ).toEqual({
      status: "error",
      error: {
        kind: "invalid_argument",
        message: ALERT_DESTINATION_LIMITS.messages.unknown_id,
      },
    });
  });
});
