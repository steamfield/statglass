import { createMockTransport } from "@core/mock-transport";
import { MOCK_HOST_ID } from "./fixtures";

it("leaves the open minute for live data and completes a fixed past range", async () => {
  const minute = 1_791_158_460_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(minute + 500);
  const transport = createMockTransport();
  try {
    const request = {
      host: MOCK_HOST_ID,
      series: [{ metric: "cpu.total", labels: [] }],
      from_ms: minute - 180_000,
      to_ms: null,
      max_points: 50,
      events_for: null,
    };
    const past = minute - 120_123;
    expect(await transport.hostHistory(request)).toMatchObject({
      status: "ok",
      data: { complete_to_ms: minute - 60_000 },
    });
    expect(
      await transport.hostHistory({ ...request, to_ms: past })
    ).toMatchObject({
      status: "ok",
      data: { complete_to_ms: past },
    });
  } finally {
    transport.dispose();
    vi.useRealTimers();
  }
});
