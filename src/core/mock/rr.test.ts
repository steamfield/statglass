import { createMockTransport } from "@core/mock-transport";

it("exposes no local lock by default and two peer jobs plus a long command", async () => {
  const transport = createMockTransport({
    scenarios: ["rr-jobs"],
    historyRows: 1,
  });
  try {
    expect(await transport.localRrJob()).toBeNull();
    const hosts = await transport.listRemoteHosts();
    expect(hosts).toHaveLength(3);
    const [first, second, third] = hosts;
    expect(first?.status.rr?.peers).toEqual([second?.config.id]);
    expect(second?.status.rr?.peers).toEqual([first?.config.id]);
    expect(third?.status.rr?.peers).toEqual([]);
    expect(third?.status.rr?.command).toHaveLength(200);
    expect(first?.status.rr?.user).toBe(second?.status.rr?.user);
    expect(first?.status.rr?.client_hostname).toBe(
      second?.status.rr?.client_hostname
    );
  } finally {
    transport.dispose();
  }
});

it("defaults every ordinary mock host to no job", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    historyRows: 1,
  });
  try {
    expect(
      (await transport.listRemoteHosts()).every(
        (host) => host.status.rr === null
      )
    ).toBe(true);
  } finally {
    transport.dispose();
  }
});

it.each(["offline", "disable", "remove", "repair"] as const)(
  "clears job and peer state on %s",
  async (action) => {
    const transport = createMockTransport({
      scenarios: ["rr-jobs"],
      historyRows: 1,
    });
    try {
      const [first, second] = await transport.listRemoteHosts();
      if (!first || !second) throw new Error("Missing peer jobs");
      switch (action) {
        case "offline":
          transport.pushRemoteStatus(first.config.id, { state: "offline" });
          break;
        case "disable":
          await transport.updateRemoteHost({ ...first.config, enabled: false });
          break;
        case "remove":
          await transport.removeRemoteHost(
            first.config.id,
            false,
            false,
            false,
            false
          );
          break;
        case "repair":
          await transport.repairRemoteHost(first.config.id);
          break;
      }
      const hosts = await transport.listRemoteHosts();
      expect(
        hosts.find((host) => host.config.id === second.config.id)?.status.rr
          ?.peers
      ).toEqual([]);
      const previous = hosts.find((host) => host.config.id === first.config.id);
      if (previous) expect(previous.status.rr).toBeNull();
      if (action === "repair")
        expect(
          hosts.find((host) => host.config.id.endsWith("-repaired"))?.status.rr
        ).toBeNull();
    } finally {
      transport.dispose();
    }
  }
);
