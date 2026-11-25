import { createMockTransport } from "../mock-transport";
import { CommandFailure } from "../transport";
import { MOCK_HOST_ID } from "./fixtures";
import { phoneCommandFailures } from "./phone-errors";

it("queues phone and desktop command failures independently and consumes each once", async () => {
  const transport = createMockTransport({ historyRows: 2 });
  const { retryNetwork, retryTimeout } = phoneCommandFailures;
  const request = {
    host: MOCK_HOST_ID,
    series: [{ metric: "cpu.total", labels: [] }],
    from_ms: 0,
    to_ms: 60_000,
    max_points: 31,
    events_for: null,
  };
  transport.failNext("hostVitals", retryTimeout);
  transport.failNext("hostHistory", retryTimeout);
  transport.failNext("hostHistory", retryNetwork);

  await expect(transport.hostHistory(request)).resolves.toEqual({
    status: "error",
    error: retryTimeout,
  });
  await expect(transport.hostVitals(MOCK_HOST_ID)).resolves.toEqual({
    status: "error",
    error: retryTimeout,
  });
  await expect(transport.hostHistory(request)).resolves.toEqual({
    status: "error",
    error: retryNetwork,
  });
  await expect(transport.hostHistory(request)).resolves.toMatchObject({
    status: "ok",
  });
  await expect(transport.hostVitals(MOCK_HOST_ID)).resolves.toMatchObject({
    status: "ok",
  });
  transport.dispose();
});

it("rejects a raw registry read with its typed error and recovers", async () => {
  const transport = createMockTransport({ historyRows: 2 });
  const { registry } = phoneCommandFailures;
  transport.failNext("listHosts", registry);
  await expect(transport.listHosts()).rejects.toEqual(
    new CommandFailure(registry)
  );
  expect(await transport.listHosts()).toEqual([
    expect.objectContaining({ id: MOCK_HOST_ID }),
  ]);
  transport.dispose();
});

it("failed live setup returns the typed error without delivering messages or leaving a stream", async () => {
  const transport = createMockTransport({ historyRows: 2 });
  const { status } = phoneCommandFailures;
  transport.failNext("subscribeLive", status);
  const receive = vi.fn();
  const sub = await transport.subscribeLive(MOCK_HOST_ID, receive);
  expect(sub.info).toEqual({ status: "error", error: status });
  expect(receive).not.toHaveBeenCalled();
  expect(transport.subscriberCount()).toBe(0);
  sub.unsubscribe();
  const next = await transport.subscribeLive(MOCK_HOST_ID, receive);
  expect(next.info.status).toBe("ok");
  next.unsubscribe();
  transport.dispose();
});
