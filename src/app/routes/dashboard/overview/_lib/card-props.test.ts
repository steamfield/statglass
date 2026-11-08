import { type LiveProcess, METRIC_CODES } from "@core/generated/bindings";
import { liveProcess } from "@tests/fixtures/processes";
import {
  batteryCard,
  cpuCard,
  diskCard,
  gpuCard,
  memoryCard,
  networkCard,
  powerCard,
  topProcesses,
} from "./card-props";
import { sensorPowerCard, usedMemoryCard } from "./host-card-props";

const proc = (p: Partial<LiveProcess> & { pid: number }): LiveProcess =>
  liveProcess({ start_time_us: 1, name: `p${p.pid}`, cpu_pct: null, ...p });

describe("Overview facts", () => {
  it("ranks measured processes and keys them by pid and start time", () => {
    expect(
      topProcesses(
        [
          proc({ pid: 1, name: "kernel_task", energy: 18 }),
          proc({ pid: 2, name: "Xcode", energy: 41, start_time_us: 99 }),
          proc({ pid: 3, name: "launchd" }),
        ],
        (p) => p.energy,
        String
      )
    ).toEqual([
      { id: "2:99", initial: "X", name: "Xcode", value: "41" },
      { id: "1:1", initial: "k", name: "kernel_task", value: "18" },
    ]);
  });

  it("shows machine-share process CPU, user/system and both cluster frequencies", () => {
    const card = cpuCard({
      total: 18,
      user: 12.4,
      system: 5.6,
      coreCount: 14,
      clusters: [
        { label: "P GHz", freqHz: 3.2e9 },
        { label: "E GHz", freqHz: null },
      ],
      processes: [proc({ pid: 1, cpu_pct: 86.8 })],
    });
    expect(card.value).toBe("18%");
    expect(card.list?.rows[0]?.value).toBe("6.2%");
    expect(card.stats).toEqual([
      { label: "User", value: "12.4%" },
      { label: "System", value: "5.6%" },
      { label: "P GHz", value: "3.2 GHz" },
      { label: "E GHz", value: "—" },
    ]);
  });

  it("shows frequency and I/O wait on single-kind CPUs", () => {
    const card = cpuCard({
      total: 3.1,
      user: 2,
      system: 0.9,
      iowait: 0.4,
      coreCount: 8,
      clusters: [{ label: "Frequency", freqHz: 1.2e9 }],
      processes: [],
    });
    expect(card.stats.slice(2)).toEqual([
      { label: "Frequency", value: "1.2 GHz" },
      { label: "I/O wait", value: "0.4%" },
    ]);
  });
});

const power = {
  system: 14.8,
  cpu: 6.4,
  gpu: 3.1,
  dram: 0.9,
  hottestC: 61,
  fanRpm: 1860,
  passive: false,
  powerSource: "battery" as const,
  temperature: "C" as const,
  processes: [],
};

describe("Power facts", () => {
  it("shows source units and both component facts", () => {
    const card = powerCard(power);
    expect(card.value).toBe("14.8 W");
    expect(card.unit).toBe(" on battery");
    expect(card.stats[3]).toEqual({ label: "GPU + DRAM", value: "4.0 W" });
    for (const powerSource of ["adapter", "charging"] as const)
      expect(powerCard({ ...power, powerSource }).unit).toBe(" on adapter");
    expect(powerCard({ ...power, powerSource: null }).unit).toBeUndefined();
  });
  it.each([{ gpu: null }, { dram: null }])(
    "keeps a missing component total as a gap: %o",
    (missing) => {
      expect(powerCard({ ...power, ...missing }).stats[3]?.value).toBe("—");
    }
  );
  it("shows passive cooling without fans", () => {
    expect(
      powerCard({ ...power, passive: true, fanRpm: null }).stats[1]?.value
    ).toBe("Passive cooling");
  });
  it("keeps sensor facts and hottest-first rows without component facts", () => {
    const card = sensorPowerCard({
      ...power,
      sensors: [
        { name: "Cool", c: 30 },
        { name: "Hot", c: 70 },
        { name: "Missing", c: null },
      ],
    });
    expect(card.stats.map((s) => s.label)).toEqual(["Hottest sensor", "Fans"]);
    expect(card.list?.rows.map((s) => s.name)).toEqual(["Hot", "Cool"]);
    expect(card.unit).toBe(" on battery");
  });
});

const memory = {
  used: 17.6e9,
  app: 11.6e9,
  wired: 4.5e9,
  compressed: 1.5e9,
  pressureLevel: METRIC_CODES["mem.pressure_level"].warn,
  swapUsed: 512e6,
  binary: false,
  processes: [],
};

describe("Memory facts", () => {
  it("shows used bytes, the pressure word and wired plus compressed", () => {
    const card = memoryCard(memory);
    expect(card.value).toBe("17.6 GB");
    expect(card.stats[0]).toEqual({ label: "Pressure", value: "warn" });
    expect(card.alert).toEqual({ tone: "warn", text: "Pressure warn" });
    expect(card.stats[3]?.value).toBe("6.0 GB");
    expect(memoryCard({ ...memory, binary: true }).value).toBe("16.4 GiB");
  });
  it.each([{ wired: null }, { compressed: null }])(
    "keeps a missing composition total as a gap: %o",
    (missing) => {
      expect(memoryCard({ ...memory, ...missing }).stats[3]?.value).toBe("—");
    }
  );
  it("uses Linux used/cached/PSI/swap facts", () => {
    const card = usedMemoryCard({ ...memory, cached: 3e9, psiSome: 0.4 });
    expect(card.stats.map((s) => [s.label, s.value])).toEqual([
      ["Used", "17.6 GB"],
      ["Cached", "3.0 GB"],
      ["Pressure stall", "0.4%"],
      ["Swap", "512 MB"],
    ]);
  });
});

const network = {
  primary: { iface: "en0", rx: 38.4e6, tx: 1.2e6 },
  linkBps: 1.2e9,
  total: { rx: 38.6e6, tx: 1.25e6 },
  interfaces: [{ iface: "en0", rx: 38.4e6, tx: 1.2e6 }],
  rate: "MBps" as const,
  processes: null,
};

describe("Network facts", () => {
  it("shows total rates in the selected units and primary link utilization", () => {
    const card = networkCard(network);
    expect(card.value).toBe("↑ 1.3 MB/s ↓ 38.6 MB/s");
    expect(card.stats).toEqual([
      { label: "Of link", value: "26%" },
      { label: "Interface", value: "en0" },
    ]);
    expect(networkCard({ ...network, rate: "Mbps" }).value).toBe(
      "↑ 10.0 Mb/s ↓ 309 Mb/s"
    );
  });
  it("keeps totals without a primary interface or link speed", () => {
    expect(networkCard({ ...network, primary: null }).value).toBe(
      "↑ 1.3 MB/s ↓ 38.6 MB/s"
    );
    expect(networkCard({ ...network, linkBps: null }).stats[0]?.value).toBe(
      "—"
    );
  });
  it("ranks interfaces by total rate and leaves out half-known rates", () => {
    const card = networkCard({
      ...network,
      interfaces: [
        { iface: "en0", rx: 2e6, tx: null },
        { iface: "en1", rx: 1e6, tx: 0.5e6 },
      ],
    });
    expect(card.list?.rows.map((r) => r.name)).toEqual(["en1"]);
  });
  it("ranks measured active processes, keeping the coverage note", () => {
    const card = networkCard({
      ...network,
      processes: [
        proc({ pid: 1, name: "node", net_rx_bps: 3e6, net_tx_bps: 1.2e6 }),
        proc({ pid: 2, name: "Safari", net_rx_bps: 21.4e6, net_tx_bps: 0.7e6 }),
        proc({ pid: 3, name: "idle", net_rx_bps: 0, net_tx_bps: 0 }),
        proc({ pid: 4 }),
      ],
    });
    expect(card.list?.rows.map((r) => [r.name, r.value])).toEqual([
      ["Safari", "22.1 MB/s"],
      ["node", "4.2 MB/s"],
    ]);
    expect(card.list?.note).toBe("Your processes only");
    expect(card.list?.caption).toBe("Now");
    expect(
      networkCard({ ...network, processes: [proc({ pid: 1 })] }).list?.rows
    ).toEqual([]);
  });
});

it("GPU omits its list without per-process GPU", () => {
  expect(
    gpuCard({
      util: 20,
      render: 15,
      tiler: 5,
      freqHz: 1e9,
      powerW: 3,
      processes: null,
    }).list
  ).toBeUndefined();
});
it("Disk shows used capacity from disk.used and current read/write rates", () => {
  const card = diskCard({
    read: 220e6,
    write: 48e6,
    totalBytes: 1000e9,
    usedBytes: 388e9,
    bytes: "GB",
    rate: "MBps",
    processes: [],
  });
  expect(card.value).toBe("↑ 220 MB/s ↓ 48.0 MB/s");
  expect(card.stats).toEqual([{ label: "Used", value: "388 GB of 1.0 TB" }]);
});

const battery = {
  charge: 87,
  charging: 0,
  external: 0,
  timeRemainingMin: 372,
  health: 94,
  cycles: 212,
  capacityWh: 68.2,
  designWh: 72.6,
  powerW: -14.8,
  tempC: null,
  systemW: 14.8,
};

describe("Battery facts", () => {
  it("shows charge, source and four live facts without a list", () => {
    const card = batteryCard(battery, "battery");
    expect(card.value).toBe("87%");
    expect(card.unit).toBe(" on battery");
    expect(card.stats).toEqual([
      { label: "Remaining", value: "6:12" },
      { label: "Health", value: "94%" },
      { label: "Cycles", value: "212" },
      { label: "Battery power", value: "−14.8 W" },
    ]);
    expect(card.list).toBeUndefined();
  });
  it("shows charging and adapter wording, positive power and absent source", () => {
    const card = batteryCard(
      { ...battery, timeRemainingMin: 65, powerW: 30 },
      "charging"
    );
    expect(card.unit).toBe(" charging");
    expect(card.stats[0]).toEqual({ label: "To full", value: "1:05" });
    expect(card.stats[3]?.value).toBe("30.0 W");
    expect(batteryCard(battery, "adapter").unit).toBe(" on adapter");
    expect(batteryCard(battery, null).unit).toBeUndefined();
    expect(batteryCard(battery, "unknown").unit).toBeUndefined();
  });
  it("keeps missing readings as gaps", () => {
    const card = batteryCard(
      {
        ...battery,
        charge: null,
        timeRemainingMin: null,
        health: null,
        cycles: null,
        powerW: null,
      },
      "battery"
    );
    expect(card.value).toBe("—");
    expect(card.stats.map((stat) => stat.value)).toEqual(["—", "—", "—", "—"]);
    expect(
      batteryCard({ ...battery, timeRemainingMin: null }, "charging").stats[0]
    ).toEqual({ label: "To full", value: "On power" });
  });
});
