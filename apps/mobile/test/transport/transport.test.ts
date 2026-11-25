import type {
  CommandError,
  HostHistoryRequest,
  LiveMsg,
  MobileCall,
  MobileConfig,
} from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import { expect, jest, test } from "@jest/globals";
import { BUILD_INFO, FakeNative, ok } from "@test/transport/fake-native";
import { HOST, REMOTE } from "@test/transport/native-fixtures";
import {
  createNativeTransport,
  nativeBuildInfo,
  parseEnvelope,
  protocolRangeText,
  startNativeTransport,
  toRemoteHostRecord,
} from "@/transport";

const host = HOST;
const cfg: MobileConfig = { hosts: [], data: { live_on_cellular: false } };
const error: CommandError = { kind: "internal", message: "fixture failure" };
const failed = JSON.stringify({ status: "error", error });
const frame: LiveMsg = {
  kind: "frame",
  ts_ms: 1000,
  layout_no: 1,
  timeline: 0,
  values: [19],
  held: [19],
};

const remote = REMOTE;

test("keeps complete command envelopes and quotes a bounded preview for invalid responses", () => {
  expect(parseEnvelope(ok({ answer: 42 }))).toEqual({
    status: "ok",
    data: { answer: 42 },
  });
  expect(parseEnvelope(failed)).toEqual({ status: "error", error });
  for (const json of [
    "not json",
    '{"x":1}',
    "null",
    '{"status":"ok"}',
    '{"status":"error"}',
    "x".repeat(201),
  ]) {
    expect(parseEnvelope(json)).toEqual({
      status: "error",
      error: {
        kind: "internal",
        message: `Invalid core response: "${json.slice(0, 200)}"`,
      },
    });
  }
});

test("keeps stream ids distinct across wrappers of the same native core", async () => {
  const native = new FakeNative();
  const first = createNativeTransport(native);
  const second = createNativeTransport(native);
  const firstFrames = jest.fn();
  const secondFrames = jest.fn();
  await first.subscribeLive(host, firstFrames);
  await second.subscribeLive(host, secondFrames);
  native.emit("onLive", { stream: 1, message: JSON.stringify(frame) });
  expect(firstFrames).toHaveBeenCalledWith(frame);
  expect(secondFrames).not.toHaveBeenCalled();
  first.dispose();
  const third = createNativeTransport(native);
  const sub = await third.subscribeLive(host, () => undefined);
  expect(sub.info).toMatchObject({ status: "ok", data: { stream: 3 } });
  third.dispose();
  second.dispose();
});

test("starts the core with a serialized config and preserves its startup error", async () => {
  const native = new FakeNative();
  const started = await startNativeTransport(native, cfg);
  expect(native.start).toHaveBeenCalledWith(JSON.stringify(cfg));
  expect(started.status).toBe("ok");
  if (started.status === "ok") started.data.dispose();
  native.start.mockResolvedValueOnce(failed);
  await expect(startNativeTransport(native, cfg)).resolves.toEqual({
    status: "error",
    error,
  });
});

test("rejects startup with the parsed error for an unavailable phone key", async () => {
  const native = new FakeNative();
  native.start.mockRejectedValueOnce(
    Object.assign(new Error("Could not load the phone key (OSStatus -25308)"), {
      code: "ERR_STATGLASS_KEYCHAIN",
    })
  );
  await expect(startNativeTransport(native, cfg)).rejects.toEqual({
    kind: "keychain",
    osStatus: -25308,
    message: "Could not load the phone key",
  });
});

test("preserves an Expo rejection for data-directory setup", async () => {
  const native = new FakeNative();
  const rejection = Object.assign(
    new Error("Could not create data directory"),
    {
      code: "ERR_UNEXPECTED",
    }
  );
  native.start.mockRejectedValueOnce(rejection);
  await expect(startNativeTransport(native, cfg)).rejects.toBe(rejection);
});

test("sends commands as generated MobileCall tags and JSON arguments", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  native.call.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([]));
  const query: HostHistoryRequest = {
    host,
    series: [{ metric: "cpu.total", labels: [] }],
    from_ms: 0,
    to_ms: 10,
    events_for: null,
    max_points: 1,
  };
  const calls = [
    { method: "list_hosts" },
    { method: "list_remote_hosts" },
    { method: "get_host", args: { host } },
    { method: "get_capabilities", args: { host } },
    { method: "host_vitals", args: { host } },
    { method: "retry_remote_host", args: { host } },
    { method: "host_history", args: query },
    { method: "network_addresses", args: { host } },
    { method: "set_hosts", args: { hosts: [] } },
    { method: "set_data_policy", args: cfg.data },
    { method: "authorized_key_line", args: { comment: "phone" } },
    { method: "build_info" },
  ] satisfies MobileCall[];
  expect(await transport.listHosts()).toEqual([]);
  expect(await transport.listRemoteHosts()).toEqual([]);
  await transport.getHost(host);
  await transport.getCapabilities(host);
  await transport.hostVitals(host);
  await transport.retryRemoteHost(host);
  await transport.hostHistory(query);
  await transport.networkAddresses(host);
  await transport.setHosts([]);
  await transport.setDataPolicy(cfg.data);
  await transport.authorizedKeyLine("phone");
  await transport.buildInfo();
  expect(native.call.mock.calls).toEqual(
    calls.map((call) => [
      call.method,
      JSON.stringify("args" in call ? call.args : null),
    ])
  );
  expect(native.call).toHaveBeenCalledWith("get_host", `{"host":"${host}"}`);
  expect(native.call).toHaveBeenCalledWith("list_hosts", "null");
  transport.dispose();
});

test("delivers the first live frame before subscribe resolves, filters by id and never reuses an id", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  const next = { ...frame, ts_ms: 2000 };
  const messages = jest.fn<(msg: LiveMsg) => void>();
  const subscribe = native.call.getMockImplementation();
  native.call.mockImplementationOnce(async (method, args) => {
    native.emit("onLive", { stream: 1, message: JSON.stringify(frame) });
    return subscribe?.(method, args) ?? ok(null);
  });
  const first = await transport.subscribeLive(host, messages, {
    backfillMs: 0,
    minPeriodMs: 1000,
    series: [{ metric: "cpu.total", labels: [] }],
  });
  const second = await transport.subscribeLive(host, () => undefined);
  native.emit("onLive", { stream: 2, message: JSON.stringify(next) });
  native.emit("onLive", { stream: 1, message: JSON.stringify(next) });
  first.unsubscribe();
  native.emit("onLive", { stream: 1, message: JSON.stringify(frame) });
  const third = await transport.subscribeLive(host, () => undefined);
  expect(messages.mock.calls).toEqual([[frame], [next]]);
  const calls = [
    {
      method: "subscribe_live",
      args: {
        host,
        stream: 1,
        backfill_ms: 0,
        min_period_ms: 1000,
        series: [{ metric: "cpu.total", labels: [] }],
      },
    },
    {
      method: "subscribe_live",
      args: {
        host,
        stream: 2,
        backfill_ms: null,
        min_period_ms: null,
        series: null,
      },
    },
    { method: "unsubscribe_live", args: { stream: 1 } },
    {
      method: "subscribe_live",
      args: {
        host,
        stream: 3,
        backfill_ms: null,
        min_period_ms: null,
        series: null,
      },
    },
  ] satisfies MobileCall[];
  expect(
    native.call.mock.calls.map(([method, args]) => ({
      method,
      args: JSON.parse(args),
    }))
  ).toEqual(calls);
  second.unsubscribe();
  third.unsubscribe();
});

test("rejects a failed live subscription with the command error and releases its listener", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  const messages = jest.fn();
  native.call.mockResolvedValueOnce(failed);
  await expect(transport.subscribeLive(host, messages)).rejects.toEqual(error);
  native.emit("onLive", { stream: 1, message: JSON.stringify(frame) });
  expect(messages).not.toHaveBeenCalled();
  expect(native.listenerCount("onLive")).toBe(0);
  transport.dispose();
});

test("drops malformed live messages and keeps delivering frames", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const emitterError = jest
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  const messages = jest.fn();
  const sub = await transport.subscribeLive(host, messages);
  const malformed = `not json ${"x".repeat(200)}`;
  expect(() =>
    native.emit("onLive", { stream: 1, message: "not json" })
  ).not.toThrow();
  native.emit("onLive", { stream: 1, message: malformed });
  native.emit("onLive", { stream: 1, message: JSON.stringify(frame) });
  expect(messages.mock.calls).toEqual([[frame]]);
  expect(emitterError).not.toHaveBeenCalled();
  expect(warn.mock.calls).toEqual([
    [expect.stringContaining("onLive"), "not json"],
    [expect.stringContaining("onLive"), malformed.slice(0, 200)],
  ]);
  sub.unsubscribe();
});

test("catches a throwing live consumer and keeps its subscription usable", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const emitterError = jest
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  const failure = new Error("The live consumer failed");
  const messages = jest.fn().mockImplementationOnce(() => {
    throw failure;
  });
  const sub = await transport.subscribeLive(host, messages);
  const event = { stream: 1, message: JSON.stringify(frame) };
  expect(() => native.emit("onLive", event)).not.toThrow();
  native.emit("onLive", event);
  expect(messages.mock.calls).toEqual([[frame], [frame]]);
  expect(emitterError).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("onLive"), failure);
  sub.unsubscribe();
});

test("drops malformed core events and delivers valid events past a throwing subscriber", () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const emitterError = jest
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  const failure = new Error("The first core consumer failed");
  const first = jest.fn(() => {
    throw failure;
  });
  const second = jest.fn();
  transport.onRemoteHostsChanged(first);
  transport.onRemoteHostsChanged(second);

  expect(() => native.emit("onCoreEvent", { event: "not json" })).not.toThrow();
  expect(() =>
    native.emit("onCoreEvent", { event: '{"kind":"remote_hosts_changed"}' })
  ).not.toThrow();
  expect(first.mock.calls).toEqual([[{}]]);
  expect(second.mock.calls).toEqual([[{}]]);
  expect(emitterError).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("onCoreEvent"),
    "not json"
  );
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("onCoreEvent"),
    failure
  );
  transport.dispose();
});

test("resolves getHost with a bounded command error when native.call rejects", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  const reason = `The native bridge went away ${"x".repeat(200)}`;
  native.call.mockRejectedValueOnce(new Error(reason));
  await expect(transport.getHost(host)).resolves.toEqual({
    status: "error",
    error: {
      kind: "internal",
      message: `get_host failed: ${reason.slice(0, 200)}`,
    },
  });
});

test("does not retain a callback when native listener registration throws", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  const stale = jest.fn();
  const unavailable = new Error("The event emitter is unavailable");
  jest.spyOn(native, "addListener").mockImplementationOnce(() => {
    throw unavailable;
  });
  await expect(transport.subscribeLive(host, stale)).rejects.toBe(unavailable);
  const current = await transport.subscribeLive(host, () => undefined);
  native.emit("onLive", { stream: 1, message: JSON.stringify(frame) });
  expect(stale).not.toHaveBeenCalled();
  current.unsubscribe();
  expect(native.listenerCount("onLive")).toBe(0);
});

test("stops local delivery even if the native unsubscribe command fails", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  const logged = Promise.withResolvers<unknown[]>();
  jest
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => logged.resolve(args));
  const messages = jest.fn();
  const sub = await transport.subscribeLive(host, messages);
  native.call.mockResolvedValueOnce(failed);
  sub.unsubscribe();
  native.emit("onLive", { stream: 1, message: JSON.stringify(frame) });
  expect(messages).not.toHaveBeenCalled();
  expect(native.listenerCount("onLive")).toBe(0);
  await expect(logged.promise).resolves.toEqual([
    expect.stringContaining("could not end live stream"),
    { stream: 1, error },
  ]);
});

test("maps the phone's complete remote record to the shared phone shape", () => {
  const { id, name, os, targets, connection, ...rest } = remote;
  const result = toRemoteHostRecord(remote);
  expect(result).toEqual({
    config: {
      id,
      name,
      lan: targets[0]?.host,
      tailscale: targets[1]?.host,
      enabled: true,
    },
    os,
    status: {
      ...rest,
      state: connection.state,
      route: connection.route,
      sync: connection.sync,
      error: connection.message,
      failure_kind: connection.failure,
      incompatible_side: connection.incompatible_side,
      route_failures: connection.route_failures,
      rr: null,
      update: null,
      last_update_failure: null,
      agent_update: { kind: "unknown" },
    },
  });
  expect(toRemoteHostRecord({ ...remote, targets: [] }).config).toMatchObject({
    lan: null,
    tailscale: null,
  });
});

test("signals remote changes so the listener can refetch, including a failed refetch", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  const hosts = await createMockTransport().listHosts();
  const onHosts = jest.fn();
  transport.onHostsChanged(onHosts);
  native.emit("onCoreEvent", {
    event: JSON.stringify({ kind: "hosts_changed", hosts }),
  });
  expect(onHosts).toHaveBeenCalledWith({ hosts });

  const refetch = jest.fn(() => transport.listRemoteHosts());
  const stop = transport.onRemoteHostsChanged(refetch);
  native.call.mockResolvedValueOnce(ok([remote])).mockResolvedValueOnce(failed);
  const event = { event: JSON.stringify({ kind: "remote_hosts_changed" }) };
  native.emit("onCoreEvent", event);
  await expect(refetch.mock.results[0]?.value).resolves.toEqual([
    toRemoteHostRecord(remote),
  ]);
  native.emit("onCoreEvent", event);
  await expect(refetch.mock.results[1]?.value).rejects.toMatchObject({ error });
  stop();
  native.emit("onCoreEvent", event);
  expect(refetch).toHaveBeenCalledTimes(2);
  expect(onHosts).toHaveBeenCalledTimes(1);
  transport.dispose();
});

test("disposes both native listeners and ends open and in-flight streams", async () => {
  const native = new FakeNative();
  const transport = createNativeTransport(native);
  transport.onHostsChanged(() => undefined);
  transport.onRemoteHostsChanged(() => undefined);
  const live = await transport.subscribeLive(host, () => undefined);
  const reply = Promise.withResolvers<string>();
  native.call.mockReturnValueOnce(reply.promise);
  const pending = transport.subscribeLive(host, () => undefined);
  expect(native.listenerCount("onLive")).toBe(1);
  expect(native.listenerCount("onCoreEvent")).toBe(2);
  transport.dispose();
  live.unsubscribe();
  expect(native.listenerCount("onLive")).toBe(0);
  expect(native.listenerCount("onCoreEvent")).toBe(0);
  reply.resolve(ok(null));
  await expect(pending).rejects.toMatchObject({ kind: "internal" });
  expect(
    native.call.mock.calls.filter(([method]) => method === "unsubscribe_live")
  ).toEqual([
    ["unsubscribe_live", '{"stream":1}'],
    ["unsubscribe_live", '{"stream":2}'],
  ]);
});

test("reads the core version and formats single or mixed protocol versions", () => {
  const native = new FakeNative();
  expect(nativeBuildInfo(null)).toBeNull();
  expect(nativeBuildInfo(native)).toEqual(BUILD_INFO);
  native.version.mockReturnValueOnce(failed);
  expect(nativeBuildInfo(native)).toBeNull();
  expect(protocolRangeText(BUILD_INFO)).toBe("3 to 5");
  expect(protocolRangeText({ ...BUILD_INFO, protocol_max: 3 })).toBe("3");
});

test("returns no build info and warns when native version throws", () => {
  const native = new FakeNative();
  const failure = new Error("The version bridge went away");
  native.version.mockImplementationOnce(() => {
    throw failure;
  });
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(nativeBuildInfo(native)).toBeNull();
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("version"),
    failure
  );
});
