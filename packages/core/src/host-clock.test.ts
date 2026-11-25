import { hostClock, hostTime } from "./host-clock";

it("projects a fixed timestamp using the signed host offset", () => {
  const wallMs = 1_700_000_000_000;
  expect(hostTime(wallMs, 47_000)).toBe(1_700_000_047_000);
  expect(hostTime(wallMs, -47_000)).toBe(1_699_999_953_000);
});

describe("source-relative clock", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([-120000, 120000])(
    "keeps %d ms skew and advances monotonically across controller clock changes",
    (offset) => {
      const monotonic = vi.spyOn(performance, "now").mockReturnValue(500);
      const clock = hostClock(offset, 1000000, 500);
      expect(clock()).toBe(1000000 + offset);
      vi.spyOn(Date, "now").mockReturnValue(9000000);
      monotonic.mockReturnValue(1500);
      expect(clock()).toBe(1001000 + offset);
    }
  );
});
