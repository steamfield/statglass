import type { SeriesKey } from "@core/generated/bindings";
import { type HostLive, initialHostLive, reduceLive } from "@core/live-state";
import { frameMsg, layoutMsg } from "@tests/live-frames";
import { selectVolumeCapacity } from "~/stores/live-selectors";
import { ifaceRates, linkRate } from "./selectors";

const SERIES: SeriesKey[] = [
  { metric: "net.rx", labels: [["iface", "en0"]] },
  { metric: "net.tx", labels: [["iface", "en0"]] },
  { metric: "net.link_rate", labels: [["iface", "en0"]] },
  { metric: "disk.total", labels: [["vol", "/System/Volumes/Data"]] },
  { metric: "disk.free", labels: [["vol", "/System/Volumes/Data"]] },
  { metric: "disk.total", labels: [["vol", "/"]] },
  { metric: "disk.free", labels: [["vol", "/"]] },
  { metric: "disk.used", labels: [["vol", "/"]] },
];

const VALUES = [38.4e6, 1.2e6, 1.2e9, 1e12, 600e9, 1e12, 612e9, 380e9];

const state = [
  layoutMsg(1, SERIES),
  frameMsg(1, 1000, VALUES),
].reduce<HostLive>(reduceLive, initialHostLive("h1"));

describe("overview selectors", () => {
  it("flattens interface rates and reads the link speed", () => {
    expect(ifaceRates(state)).toEqual({ "rx|en0": 38.4e6, "tx|en0": 1.2e6 });
    expect(linkRate(state, "en0")).toBe(1.2e9);
    expect(linkRate(state, null)).toBeNull();
  });

  it("reads one volume's capacity, used straight from disk.used", () => {
    expect(selectVolumeCapacity(state, "/")).toEqual({
      total: 1e12,
      free: 612e9,
      used: 380e9,
    });
    expect(selectVolumeCapacity(state, null)).toEqual({
      total: null,
      free: null,
      used: null,
    });
  });
});
