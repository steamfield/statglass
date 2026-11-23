import type {
  AlertDestinationsView,
  DeliveryFailure,
  DeliveryRecord,
  Destination,
} from "@core/generated/bindings";
import { describe, expect, it } from "vitest";
import {
  deliveryLabel,
  destinationAddress,
  generateTopic,
} from "./alert-destinations";
import { createMockTransport } from "./mock-transport";

const AT = 1_800_000_000_000;
const timeOf = (ms: number) => (ms === AT ? "14:02" : `t${ms}`);

function ntfy(n: number, overrides: Partial<Destination> = {}): Destination {
  return {
    id: `de570000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Phone ${n}`,
    enabled: true,
    kind: {
      type: "ntfy",
      server: "https://ntfy.sh",
      topic: `statglass-topic-${n}`,
      token: null,
    },
    ...overrides,
  };
}

function webhook(n: number, url: string): Destination {
  return {
    id: `de580000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Chat ${n}`,
    enabled: true,
    kind: { type: "webhook", url },
  };
}

function failedAt(
  detail: string,
  reason: DeliveryFailure = "http"
): DeliveryRecord {
  return { at_ms: AT, outcome: { kind: "failed", reason, detail } };
}

function listed(destinations: Destination[]): AlertDestinationsView {
  return {
    destinations: destinations.map((destination) => ({
      destination,
      last: null,
    })),
    load_error: null,
  };
}

describe("deliveryLabel", () => {
  it("reads a delivery as Delivered at its time", () => {
    expect(
      deliveryLabel(
        { at_ms: AT, outcome: { kind: "delivered", status: 204 } },
        timeOf
      )
    ).toBe("Delivered 14:02");
  });

  it.each([
    ["HTTP 403", "http"],
    ["HTTP 500", "http"],
    ["Timed out after 10 s", "timed_out"],
    ["Could not connect", "connect_failed"],
    ["Server name not found", "name_not_found"],
    ["TLS error", "tls"],
    ["curl is not installed at /usr/bin/curl", "curl_missing"],
  ] as const)(
    "reads a failure as Failed at its time with %s",
    (detail, reason) => {
      expect(
        deliveryLabel(
          { at_ms: AT, outcome: { kind: "failed", reason, detail } },
          timeOf
        )
      ).toBe(`Failed 14:02 · ${detail}`);
    }
  );

  it("has no label before the first delivery", () => {
    expect(deliveryLabel(null, timeOf)).toBeNull();
  });
});

describe("destinationAddress", () => {
  it("shows the ntfy host and a topic cut to 4 characters", () => {
    expect(
      destinationAddress(
        ntfy(1, {
          kind: {
            type: "ntfy",
            server: "https://ntfy.sh",
            topic: "statglass-4f2a9kq7xm3b",
            token: "tk_example_secret",
          },
        })
      )
    ).toBe("ntfy.sh/stat…");
  });

  it("always elides the topic, and shows the host alone for a short topic", () => {
    const address = (topic: string, server = "https://ntfy.example.com/") =>
      destinationAddress(
        ntfy(1, { kind: { type: "ntfy", server, topic, token: null } })
      );
    expect(address("alerts")).toBe("ntfy.example.com/aler…");
    expect(address("abcde")).toBe("ntfy.example.com/abcd…");
    expect(address("abcd")).toBe("ntfy.example.com");
    expect(address("alerts", "http://ntfy.local:8080")).toBe(
      "ntfy.local/aler…"
    );
  });

  it("shows only a webhook's host, never its path or query", () => {
    expect(
      destinationAddress(
        webhook(1, "https://chat.example.com/hooks/T0/B0/private?key=abc")
      )
    ).toBe("chat.example.com");
  });

  it.each([
    ["a port", "https://chat.example.com:8443/hooks/x", "chat.example.com"],
    ["an IPv6 literal", "http://[::1]:8080/x", "[::1]"],
    ["credentials", "https://user:secret@chat.example.com/x", ""],
    ["an upper-case scheme", "HTTPS://chat.example.com/x", ""],
    ["no address yet", "", ""],
    ["an unclosed bracket", "http://[::1/secret", ""],
  ])("reads a webhook host from a URL with %s", (_, url, shown) => {
    expect(destinationAddress(webhook(1, url))).toBe(shown);
  });
});

describe("generateTopic", () => {
  it("is statglass- and 20 base32 characters from the random bytes", () => {
    const zeros = generateTopic((n) => new Uint8Array(n));
    const ones = generateTopic((n) => new Uint8Array(n).fill(0xff));
    for (const topic of [zeros, ones]) {
      expect(topic).toMatch(/^statglass-[a-z2-7]{20}$/);
    }
    expect(zeros).not.toBe(ones);
    let seed = 7;
    const counter = (n: number) =>
      Uint8Array.from({ length: n }, () => {
        seed = (seed * 31 + 11) % 256;
        return seed;
      });
    const a = generateTopic(counter);
    const b = generateTopic(counter);
    expect(a).toMatch(/^statglass-[a-z2-7]{20}$/);
    expect(a).not.toBe(b);
  });
});

describe("mock alert destinations", () => {
  it("stores a destination and answers it back", async () => {
    const t = createMockTransport();
    expect(await t.getAlertDestinations()).toEqual(listed([]));
    const d = ntfy(1);
    expect(await t.saveAlertDestination(d)).toEqual({
      status: "ok",
      data: listed([d]),
    });
    expect(await t.getAlertDestinations()).toEqual(listed([d]));
  });

  it("replaces a destination with the same id in place", async () => {
    const t = createMockTransport();
    const a = ntfy(1);
    const b = webhook(2, "https://chat.example.com/hooks/2");
    await t.saveAlertDestination(a);
    await t.saveAlertDestination(b);
    const renamed = { ...a, name: "Renamed", enabled: false };
    expect(await t.saveAlertDestination(renamed)).toEqual({
      status: "ok",
      data: listed([renamed, b]),
    });
  });

  it("deletes a destination and refuses an unknown id", async () => {
    const t = createMockTransport();
    const a = ntfy(1);
    const b = ntfy(2);
    await t.saveAlertDestination(a);
    await t.saveAlertDestination(b);
    expect(await t.deleteAlertDestination(a.id)).toEqual({
      status: "ok",
      data: listed([b]),
    });
    const unknown = await t.deleteAlertDestination(a.id);
    expect(unknown.status === "error" && unknown.error.kind).toBe(
      "invalid_argument"
    );
    expect(await t.getAlertDestinations()).toEqual(listed([b]));
  });

  it("refuses a ninth destination", async () => {
    const t = createMockTransport();
    const eight = Array.from({ length: 8 }, (_, i) => ntfy(i + 1));
    for (const d of eight) await t.saveAlertDestination(d);
    const ninth = await t.saveAlertDestination(ntfy(9));
    expect(ninth.status === "error" && ninth.error.kind).toBe(
      "invalid_argument"
    );
    expect(await t.getAlertDestinations()).toEqual(listed(eight));
  });

  it.each([
    ["an empty name", ntfy(1, { name: "  " })],
    ["a name over 40 characters", ntfy(1, { name: "n".repeat(41) })],
    [
      "a server that is not http or https",
      ntfy(1, {
        kind: {
          type: "ntfy",
          server: "ftp://ntfy.sh",
          topic: "alerts",
          token: null,
        },
      }),
    ],
    [
      "a topic with a space",
      ntfy(1, {
        kind: {
          type: "ntfy",
          server: "https://ntfy.sh",
          topic: "my alerts",
          token: null,
        },
      }),
    ],
    ["a file URL", webhook(1, "file:///etc/hosts")],
  ])("refuses %s as Rust does", async (_, destination) => {
    const t = createMockTransport();
    const result = await t.saveAlertDestination(destination);
    expect(result.status === "error" && result.error.kind).toBe(
      "invalid_argument"
    );
    expect(await t.getAlertDestinations()).toEqual(listed([]));
  });

  it("emits the new list after each save and delete", async () => {
    const t = createMockTransport();
    const seen: AlertDestinationsView[] = [];
    const stop = t.onAlertDestinationsChanged((view) => seen.push(view));
    const a = ntfy(1);
    await t.saveAlertDestination(a);
    await t.deleteAlertDestination(a.id);
    await t.saveAlertDestination(ntfy(2, { name: "" }));
    stop();
    await t.saveAlertDestination(ntfy(3));
    expect(seen).toEqual([listed([a]), listed([])]);
  });

  it("delivers a test message without saving the destination", async () => {
    const t = createMockTransport();
    const result = await t.testAlertDestination(ntfy(1));
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.data.kind).toBe("delivered");
    expect(await t.getAlertDestinations()).toEqual(listed([]));
  });

  it("fails test deliveries in the alert-delivery-fails scenario", async () => {
    const t = createMockTransport({ scenarios: ["alert-delivery-fails"] });
    const d = ntfy(1);
    await t.saveAlertDestination(d);
    const result = await t.testAlertDestination(d);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.kind).toBe("failed");
    expect(
      result.data.kind === "failed" &&
        deliveryLabel(failedAt(result.data.detail, result.data.reason), timeOf)
    ).toMatch(/^Failed 14:02 · .+/);
    expect(await t.getAlertDestinations()).toEqual(listed([d]));
  });
});
