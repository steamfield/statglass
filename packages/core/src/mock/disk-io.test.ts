import { mockDiskDevices, mockDiskIo } from "./disk-io";
import { MOCK_HOST_ID } from "./fixtures";

const request = {
  host: MOCK_HOST_ID,
  device: "disk3",
  from_ms: 1_700_000_000_000,
  to_ms: 1_700_000_300_000,
  max_points: 120,
};
describe("disk I/O fixtures", () => {
  it("distinguishes fast sequential traffic from slow low-volume requests", () => {
    const fast = mockDiskIo(request, ["disk-io-comparison"]).points[0];
    const slow = mockDiskIo({ ...request, device: "disk7" }, [
      "disk-io-comparison",
    ]).points[0];
    expect(fast?.read_bps).toBeGreaterThan(slow?.read_bps ?? Infinity);
    expect(fast?.read_request_ms).toBeLessThan(slow?.read_request_ms ?? 0);
    expect(mockDiskDevices([]).default_device).toBe("disk3");
  });
  it("weights an all-device point by completions, not by device count", () => {
    const page = (device: string | null) =>
      mockDiskIo({ ...request, device }, ["disk-io-comparison"]).points[0];
    const [p, fast, slow] = [page(null), page("disk3"), page("disk7")];
    const ops = (x: typeof p) => x?.read_ops_per_sec ?? Number.NaN;
    const ms = (x: typeof p) => x?.read_request_ms ?? Number.NaN;
    expect(ops(p)).toBeCloseTo(ops(fast) + ops(slow));
    expect(ms(p)).toBeCloseTo(
      (ops(fast) * ms(fast) + ops(slow) * ms(slow)) / ops(p)
    );
    expect(ms(p)).not.toBeCloseTo((ms(fast) + ms(slow)) / 2);
  });
  it("keeps missing completion counts and true idle separate", () => {
    const idle = mockDiskIo(request, ["disk-io-no-ops"]).points[0];
    expect(idle).toMatchObject({
      read_bps: 0,
      read_ops_per_sec: 0,
      read_request_ms: null,
    });
    const absent = mockDiskIo(request, ["disk-io-unavailable"]).points[0];
    expect(absent).toMatchObject({
      read_ops_per_sec: null,
      read_request_ms: null,
    });
  });
});
