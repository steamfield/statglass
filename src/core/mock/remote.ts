import type {
  RemoteHostConfig,
  RemoteHostRecord,
} from "@core/generated/bindings";
import type { MockCommands } from "./commands";
import type { MockTransport, MockTransportOptions } from "./contracts";
import type { MockEmitters } from "./emitters";
import {
  BLOCKED_REMOTE_UPDATE,
  hostRecord,
  MOCK_HOST_ID,
  type ScenarioFlags,
  type ScenarioName,
  scenarioFlags,
} from "./fixtures";
import { fail, ok } from "./protocol";
import {
  APP_VERSION,
  isLinuxAlias,
  mockLinuxPreparation,
} from "./remote-linux";
import { savedMacSetup, setupCancelled } from "./remote-setup";
import { MockRemoteStatus } from "./remote-status";
import {
  hasProgressFixture,
  MockAgentUpdates,
  mockHostVitals,
  mockLocalRrJob,
  mockMacPreparation,
  mockRestartAgent,
  remoteRecords,
  seedRemoteScenarios,
} from "./remote-updates";
import { remoteUsage, type UsageQueries } from "./remote-usage";
import type { MockRing } from "./ring";
import { syncRrJobs } from "./rr";
export class MockRemotes {
  readonly remotes = new Map<
    string,
    {
      record: RemoteHostRecord;
      peer: MockTransport;
      flags: ScenarioFlags;
      automaticUpdates: boolean;
    }
  >();
  private readonly statusEvents = new MockRemoteStatus();
  private readonly updates = new MockAgentUpdates(this);
  private trustedAliases = new Set<string>();
  private setups = new Map<string, () => void>();
  constructor(
    private readonly options: MockTransportOptions,
    private readonly ring: MockRing,
    private readonly commands: MockCommands,
    private readonly emitters: MockEmitters,
    private readonly createPeer: (
      options: MockTransportOptions
    ) => MockTransport
  ) {}
  /** `call` on a remote host's peer, as its session forwards it; null for any other host. */
  readonly forward = <T>(host: string, call: (peer: MockTransport) => T) => {
    const remote = this.remotes.get(host);
    return remote ? call(remote.peer) : null;
  };
  /** A remote's host record: what its peer reports, under the saved name. */
  private readonly remoteRecord = (
    { flags }: { flags: ScenarioFlags },
    id: string,
    name: string
  ) => ({
    ...hostRecord(flags, this.ring.startMs),
    id,
    is_local: false,
    display_name: name,
  });
  readonly allHosts = () => [
    hostRecord(this.ring.flags, this.ring.startMs),
    ...[...this.remotes.values()].map((remote) =>
      this.remoteRecord(
        remote,
        remote.record.config.id,
        remote.record.config.name
      )
    ),
  ];
  /** `peerScenarios` shape the peer: a remote Mac without battery or fans by default. */
  readonly addRemote = (
    config: RemoteHostConfig,
    peerScenarios: readonly ScenarioName[] = ["no-battery", "no-fans"]
  ): RemoteHostRecord => {
    const saved = {
      ...config,
      id: config.id || `remote-${config.lan ?? config.tailscale}`,
    };
    const linux = peerScenarios.includes("linux");
    const remote: RemoteHostRecord = {
      config: saved,
      os: linux ? "linux" : "mac_os",
      status: {
        state: saved.enabled ? "connected" : "disabled",
        route: saved.lan ? "lan" : "tailscale",
        last_seen_ms: this.ring.now(),
        error: null,
        sync: "current",
        clock_offset_ms: 120000,
        agent_version: APP_VERSION,
        agent_update: { kind: "up_to_date", installed: APP_VERSION },
        identity_changed: null,
        rr: null,
        vitals: mockHostVitals(linux),
        update: null,
        last_update_failure: null,
      },
    };
    this.statusEvents.forget(saved.id);
    this.remotes.set(saved.id, {
      record: remote,
      automaticUpdates: true,
      flags: scenarioFlags(peerScenarios),
      peer: this.createPeer({
        ...this.options,
        latencyMs: 0,
        scenarios: [...peerScenarios],
        now: () => this.ring.now() + 120000,
      }),
    });
    return remote;
  };
  readonly remoteSshConfigStatus: MockTransport["remoteSshConfigStatus"] =
    async () => {
      this.commands.record("remote_ssh_config_status");
      return ok(
        this.options.scenarios?.includes("ssh-no-config")
          ? "missing"
          : "present"
      );
    };
  readonly inspectRemoteSshHost: MockTransport["inspectRemoteSshHost"] = async (
    alias
  ) => {
    this.commands.record("inspect_remote_ssh_host", alias);
    return ok({
      token: alias,
      alias,
      hostname: alias,
      port: 22,
      fingerprints: ["256 SHA256:exampleMockHostFingerprint (ED25519)"],
    });
  };
  readonly acceptRemoteSshHost: MockTransport["acceptRemoteSshHost"] = async (
    token
  ) => {
    this.commands.record("accept_remote_ssh_host", token);
    this.trustedAliases.add(token);
    return ok(null);
  };
  readonly listRemoteHosts: MockTransport["listRemoteHosts"] = async () => {
    return remoteRecords(this, this.options.scenarios ?? [], this.ring.now());
  };
  readonly hostVitals: MockTransport["hostVitals"] = async (host) => {
    if (host === MOCK_HOST_ID) return ok(mockHostVitals(this.ring.flags.linux));
    const remote = this.remotes.get(host);
    return remote
      ? ok(remote.record.status.vitals)
      : fail({ kind: "unknown_host", host });
  };
  readonly setHostsRecentInterest: MockTransport["setHostsRecentInterest"] =
    async (on) => {
      this.commands.record("set_hosts_recent_interest", on);
      return ok(null);
    };
  readonly onRemoteHostsChanged: MockTransport["onRemoteHostsChanged"] = (cb) =>
    this.emitters.remotes.on(cb);
  readonly pushRemoteStatus: MockTransport["pushRemoteStatus"] = (
    id,
    status
  ) => {
    this.statusEvents.push(this, id, status, () =>
      this.emitters.remotes.emit({})
    );
  };
  startUpdate(id: string) {
    this.updates.start(id);
  }
  readonly getRemoteUpdateStatus: MockTransport["getRemoteUpdateStatus"] =
    async (id) => {
      this.commands.record("get_remote_update_status", id);
      const remote = this.remotes.get(id);
      if (!remote) return fail({ kind: "unknown_host", host: id });
      if (remote.record.status.state === "error")
        return fail({
          kind: "remote_unreachable",
          message: remote.record.status.error ?? "Host is offline",
        });
      const { general } = (await remote.peer.getSettings()).settings;
      const status = {
        supported: remote.automaticUpdates,
        check_updates: general.check_updates,
        auto_install_updates: general.auto_install_updates ?? true,
        status: remote.automaticUpdates ? "idle" : "unsupported",
        version: remote.record.status.agent_version,
        message: !remote.automaticUpdates
          ? "Update this host once to enable automatic updates."
          : null,
      };
      if (this.options.scenarios?.includes("remote-update-blocked")) {
        Object.assign(status, BLOCKED_REMOTE_UPDATE);
      }
      return ok(status);
    };
  readonly setRemoteUpdatePolicy: MockTransport["setRemoteUpdatePolicy"] =
    async (id, checkUpdates, autoInstallUpdates) => {
      this.commands.record(
        "set_remote_update_policy",
        id,
        checkUpdates,
        autoInstallUpdates
      );
      const remote = this.remotes.get(id);
      if (!remote) return fail({ kind: "unknown_host", host: id });
      if (!remote.automaticUpdates || remote.record.status.state === "error")
        return this.getRemoteUpdateStatus(id);
      const result = await remote.peer.updateSettings({
        general: {
          check_updates: checkUpdates,
          auto_install_updates: autoInstallUpdates,
        },
      });
      if (result.status === "error") return result;
      return this.getRemoteUpdateStatus(id);
    };
  readonly prepareRemoteHost: MockTransport["prepareRemoteHost"] = async (
    lan,
    tailscale
  ) => {
    this.commands.record("prepare_remote_host", lan, tailscale);
    if (this.options.scenarios?.includes("ssh-auth"))
      return fail({
        kind: "remote_auth",
        message: "Permission denied (publickey).",
      });
    if (!lan && !tailscale)
      return fail({
        kind: "invalid_argument",
        message: "Enter at least one SSH alias",
      });
    if (
      this.options.scenarios?.includes("ssh-untrusted") &&
      !this.trustedAliases.has(lan ?? tailscale ?? "")
    )
      return fail({
        kind: "host_key_unknown",
        message:
          "Host key verification failed: verify the SSH host fingerprint.",
      });
    const alias = lan ?? tailscale ?? "";
    if (isLinuxAlias(alias)) {
      const first = [...this.remotes.values()][0]?.record.config.name ?? null;
      const linux = mockLinuxPreparation(
        this.identityReset.has(alias) ? "linux" : alias,
        first
      );
      return "error" in linux ? fail(linux.error) : ok(linux.ok);
    }
    return ok(mockMacPreparation(alias, this));
  };
  /** Aliases whose agent was given a new identity; they prepare as a fresh host. */
  private identityReset = new Set<string>();
  readonly resetRemoteHostIdentity: MockTransport["resetRemoteHostIdentity"] =
    async (lan, tailscale) => {
      this.commands.record("reset_remote_host_identity", lan, tailscale);
      this.identityReset.add(lan ?? tailscale ?? "");
      return this.prepareRemoteHost(lan, tailscale);
    };
  readonly updateRemoteAgent: MockTransport["updateRemoteAgent"] = async (
    id
  ) => {
    this.commands.record("update_remote_agent", id);
    const remote = this.remotes.get(id);
    if (!remote) return fail({ kind: "unknown_host", host: id });
    remote.automaticUpdates = true;
    if (hasProgressFixture(this.options.scenarios ?? [])) {
      this.startUpdate(id);
      return ok(null);
    }
    this.pushRemoteStatus(id, {
      state: "connected",
      error: null,
      agent_version: APP_VERSION,
      agent_update: { kind: "up_to_date", installed: APP_VERSION },
      update: null,
      last_update_failure: null,
    });
    this.emitHostsChanged();
    return ok(null);
  };
  readonly repairRemoteHost: MockTransport["repairRemoteHost"] = async (id) => {
    this.commands.record("repair_remote_host", id);
    const remote = this.remotes.get(id);
    if (!remote) return fail({ kind: "unknown_host", host: id });
    const { config, status, os } = remote.record;
    const newId = status.identity_changed ?? `${id}-repaired`;
    remote.record = {
      ...remote.record,
      config: {
        ...config,
        name: `${config.name} (before re-pair)`,
        enabled: false,
      },
      status: {
        ...remote.record.status,
        state: "disabled",
        error: null,
        identity_changed: null,
      },
    };
    const record = this.addRemote(
      {
        ...config,
        id: newId,
      },
      os === "linux" ? ["linux"] : undefined
    );
    this.emitHostsChanged();
    return ok(record);
  };
  readonly cancelRemoteSetup: MockTransport["cancelRemoteSetup"] = async (
    setupId
  ) => {
    this.commands.record("cancel_remote_setup", setupId);
    this.setups.get(setupId)?.();
    return ok(null);
  };
  readonly addRemoteHost: MockTransport["addRemoteHost"] = async (
    config,
    install,
    showMenuBar,
    setupId,
    reinstall = null
  ) => {
    this.commands.record(
      "add_remote_host",
      config,
      install,
      showMenuBar,
      setupId,
      reinstall
    );
    if (
      await setupCancelled(
        this.setups,
        this.options.remoteSetupDelayMs,
        setupId
      )
    )
      return fail({
        kind: "invalid_argument",
        message: "Setup cancelled. Remote settings were restored.",
      });
    const savedMac = savedMacSetup(this, config, reinstall);
    if (savedMac) return savedMac;
    const alias = config.lan ?? config.tailscale ?? "";
    if (alias.includes("dup") && !this.identityReset.has(alias))
      return fail({
        kind: "remote_identity",
        message:
          "This host reports the same identity as a host already in your host list",
      });
    const result = this.addRemote(
      config,
      isLinuxAlias(config.lan ?? config.tailscale ?? "") ? ["linux"] : undefined
    );
    this.emitHostsChanged();
    return ok(result);
  };
  readonly updateRemoteHost: MockTransport["updateRemoteHost"] = async (
    config
  ) => {
    const remote = this.remotes.get(config.id);
    if (!remote) return fail({ kind: "unknown_host", host: config.id });
    if (remote.record.status.state === "connected" && !config.enabled)
      remote.peer.endSpaceSession();
    remote.record = {
      ...remote.record,
      config,
      status: {
        ...remote.record.status,
        state: config.enabled ? "connected" : "disabled",
      },
    };
    this.emitHostsChanged();
    return ok(remote.record);
  };
  readonly removeRemoteHost: MockTransport["removeRemoteHost"] = async (
    id,
    deleteMirror,
    stopSharing,
    uninstallAgent,
    purgeAgent
  ) => {
    this.commands.record(
      "remove_remote_host",
      id,
      deleteMirror,
      stopSharing,
      uninstallAgent,
      purgeAgent
    );
    this.remotes.get(id)?.peer.dispose();
    this.remotes.delete(id);
    this.statusEvents.forget(id);
    this.emitHostsChanged();
    return ok(null);
  };
  readonly retryRemoteHost: MockTransport["retryRemoteHost"] = async (id) => {
    this.commands.record("retry_remote_host", id);
    const remote = this.remotes.get(id);
    if (!remote) return fail({ kind: "unknown_host", host: id });
    if (
      this.options.scenarios?.includes("host-unreachable") &&
      id === "remote-unreachable"
    )
      return ok(null);
    this.pushRemoteStatus(id, { state: "connected", error: null });
    return ok(null);
  };
  readonly listHosts: MockTransport["listHosts"] = async () => {
    this.commands.record("list_hosts");
    return this.allHosts();
  };
  readonly getHost: MockTransport["getHost"] = async (host) => {
    const remote = this.remotes.get(host);
    if (remote)
      return ok(this.remoteRecord(remote, host, remote.record.config.name));
    return this.commands.hostCommand("get_host", host, [host], {}, () =>
      ok(hostRecord(this.ring.flags, this.ring.startMs))
    );
  };
  readonly getCapabilities: MockTransport["getCapabilities"] = async (host) =>
    this.forward(host, (peer) => peer.getCapabilities(MOCK_HOST_ID)) ??
    this.commands.hostCommand("get_capabilities", host, [host], {}, () =>
      ok(this.ring.caps)
    );
  readonly emitHostsChanged: MockTransport["emitHostsChanged"] = () => {
    syncRrJobs(this);
    const hosts = this.allHosts();
    this.emitters.hosts.emit({ hosts });
    this.emitters.remotes.emit({});
  };
  /** App queries go to the sampled peer; remote live rows have no Quit. */
  routeUsage<T extends UsageQueries>(local: T): T {
    return remoteUsage(this.remotes, this.commands, this.options, local);
  }
  seedScenario() {
    seedRemoteScenarios(this, this.options.scenarios ?? []);
  }

  private dismissedNotice: string | null = null;
  readonly hostUpdateNoticeDismissed: MockTransport["hostUpdateNoticeDismissed"] =
    async () => ok(this.dismissedNotice);
  readonly dismissHostUpdateNotice: MockTransport["dismissHostUpdateNotice"] =
    async (key) => {
      this.commands.record("dismiss_host_update_notice", key);
      this.dismissedNotice = key;
      return ok(null);
    };
  dispose() {
    this.updates.dispose();
    for (const remote of this.remotes.values()) remote.peer.dispose();
    for (const cancel of this.setups.values()) cancel();
  }

  get methods() {
    return {
      remoteSshConfigStatus: this.remoteSshConfigStatus,
      inspectRemoteSshHost: this.inspectRemoteSshHost,
      acceptRemoteSshHost: this.acceptRemoteSshHost,
      listRemoteHosts: this.listRemoteHosts,
      hostVitals: this.hostVitals,
      localRrJob: async () =>
        this.options.scenarios?.includes("rr-jobs") ? mockLocalRrJob() : null,
      setHostsRecentInterest: this.setHostsRecentInterest,
      onRemoteHostsChanged: this.onRemoteHostsChanged,
      pushRemoteStatus: this.pushRemoteStatus,
      getRemoteUpdateStatus: this.getRemoteUpdateStatus,
      setRemoteUpdatePolicy: this.setRemoteUpdatePolicy,
      prepareRemoteHost: this.prepareRemoteHost,
      cancelRemoteSetup: this.cancelRemoteSetup,
      addRemoteHost: this.addRemoteHost,
      updateRemoteHost: this.updateRemoteHost,
      removeRemoteHost: this.removeRemoteHost,
      retryRemoteHost: this.retryRemoteHost,
      resetRemoteHostIdentity: this.resetRemoteHostIdentity,
      updateRemoteAgent: this.updateRemoteAgent,
      restartRemoteAgent: mockRestartAgent(this.commands, this.remotes),
      hostUpdateNoticeDismissed: this.hostUpdateNoticeDismissed,
      dismissHostUpdateNotice: this.dismissHostUpdateNotice,
      repairRemoteHost: this.repairRemoteHost,
      listHosts: this.listHosts,
      getHost: this.getHost,
      getCapabilities: this.getCapabilities,
      emitHostsChanged: this.emitHostsChanged,
    };
  }
}
