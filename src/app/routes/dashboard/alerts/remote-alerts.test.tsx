import {
  createMockTransport,
  type MockTransport,
  type MockTransportOptions,
} from "@core/mock-transport";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { Route, Routes } from "react-router";
import { HostSelectionContext } from "~/lib/host-selection";
import DashboardLayout from "~/routes/dashboard/route";
import { HostStoreProvider } from "~/stores/host-store";
import AlertsRoute from "./route";

const HOST = "remote-linux";
const NAME = "linux-tailscale";
const DISK = "Root disk running low";
const MEMORY = "Memory stalls";
const OFFLINE = `${NAME} is not connected`;

function mock({
  scenarios = ["linux-host"],
  ...options
}: MockTransportOptions = {}) {
  return createMockTransport({ autoTick: false, scenarios, ...options });
}

async function renderRemote(transport = mock(), waitForStatus = true) {
  const hosts = await transport.listHosts();
  const view = renderWithProviders(
    <HostSelectionContext.Provider
      value={{ hosts, selected: HOST, select: () => {} }}
    >
      <HostStoreProvider hostId={HOST}>
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path="/dashboard/alerts" element={<AlertsRoute />} />
          </Route>
        </Routes>
      </HostStoreProvider>
    </HostSelectionContext.Provider>,
    { transport, route: "/dashboard/alerts" }
  );
  onTestFinished(() => {
    view.unmount();
    transport.dispose();
  });
  if (waitForStatus) {
    await screen.findByRole("region", { name: "Recent" });
    await screen.findByRole("heading", { name: `Alerts on ${NAME}` });
  }
  return view;
}

const newButton = () => screen.getByRole("button", { name: "New rule" });
const editButton = (name: string) =>
  screen.getByRole("button", { name: `Edit ${name}` });
const ruleSwitch = (name: string) => screen.getByRole("switch", { name });
const rules = () => within(screen.getByRole("region", { name: "Rules" }));
const dialog = () => within(screen.getByRole("dialog"));
const saveButton = () => dialog().getByRole("button", { name: "Save" });
const nameInput = () => dialog().getByRole("textbox", { name: "Name" });
type User = Awaited<ReturnType<typeof renderRemote>>["user"];

async function openNew(user: User) {
  await waitFor(() => expect(newButton()).toBeEnabled());
  await user.click(newButton());
  await screen.findByRole("dialog", { name: "New rule" });
}

async function nameDraft(user: User, name: string) {
  await user.clear(nameInput());
  await user.type(nameInput(), name);
}

async function readRules(transport: MockTransport) {
  const result = await transport.remoteAlertRules(HOST);
  if (result.status === "error") throw new Error(JSON.stringify(result.error));
  return result.data;
}

it("shows the selected host’s rules, metrics and recent alerts", async () => {
  const { user } = await renderRemote(
    mock({ scenarios: ["linux-host", "alerts"] })
  );
  expect(screen.getByRole("link", { name: "Alerts" })).toBeVisible();
  await screen.findByRole("switch", { name: DISK });
  expect(rules().getAllByRole("switch")).toHaveLength(2);
  expect(
    rules().getByText(/Free disk space \(\/\) below 20 GB for 5 min/)
  ).toBeVisible();
  expect(rules().getByText(/Memory stall above 10% for 2 min/)).toBeVisible();
  expect(rules().getByText("Made by a newer version")).toBeVisible();
  expect(
    rules().queryByRole("button", { name: "Edit Made by a newer version" })
  ).toBeNull();
  expect(
    rules().getByText(
      `Rules run on ${NAME}, and alerts reach you while this Mac is awake and connected.`
    )
  ).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Send to" })).getByText(
      "Alerts from this host are sent from this Mac."
    )
  ).toBeVisible();
  expect(
    await rules().findByRole("button", { name: /Last fired/ })
  ).toBeVisible();
  const recent = () => within(screen.getByRole("region", { name: "Recent" }));
  expect(
    await recent().findByRole("button", { name: /Free disk space.*14 GB/ })
  ).toBeVisible();
  expect(recent().getAllByRole("listitem")).toHaveLength(1);

  await openNew(user);
  expect(dialog().getByRole("combobox", { name: "Metric" })).toHaveTextContent(
    "CPU usage"
  );
  await user.click(dialog().getByRole("combobox", { name: "Metric" }));
  expect(screen.queryByRole("option", { name: "Memory pressure" })).toBeNull();
  expect(screen.queryByRole("option", { name: "GPU usage" })).toBeNull();
  await user.click(screen.getByRole("option", { name: "Memory stall" }));
  expect(dialog().getByRole("combobox", { name: "Watch" })).toHaveTextContent(
    "some"
  );
  expect(dialog().getByRole("textbox", { name: "Threshold" })).toHaveValue(
    "10"
  );
});

it("creates, edits, toggles and deletes with the full last-read rules, keeping the newer rule", async () => {
  const transport = mock();
  const initial = await readRules(transport);
  const keep = initial.newer.map(({ id }) => id);
  const originalSave = transport.setRemoteAlertRules;
  const save = vi
    .spyOn(transport, "setRemoteAlertRules")
    .mockImplementation((host, revision, rules, keep) =>
      originalSave(
        host,
        revision,
        rules.map((rule) =>
          rule.name === "CPU watch"
            ? { ...rule, name: "CPU watch on the host" }
            : rule
        ),
        keep
      )
    );
  const { user } = await renderRemote(transport);
  await openNew(user);
  await nameDraft(user, "CPU watch");
  await user.click(saveButton());
  expect(
    await screen.findByRole("switch", { name: "CPU watch on the host" })
  ).toBeChecked();
  expect(screen.queryByRole("dialog")).toBeNull();
  const created = await readRules(transport);
  const newRule = created.rules.find(
    (rule) => rule.name === "CPU watch on the host"
  );
  if (!newRule) throw new Error("Expected the host to store the added rule");
  expect(save).toHaveBeenNthCalledWith(
    1,
    HOST,
    initial.revision,
    [...initial.rules, { ...newRule, name: "CPU watch" }],
    keep
  );

  await user.click(editButton(newRule.name));
  await nameDraft(user, "CPU load watch");
  await user.click(saveButton());
  expect(
    await screen.findByRole("switch", { name: "CPU load watch" })
  ).toBeChecked();
  const edited = await readRules(transport);
  const editedRule = { ...newRule, name: "CPU load watch" };
  expect(save).toHaveBeenNthCalledWith(
    2,
    HOST,
    created.revision,
    [...initial.rules, editedRule],
    keep
  );

  await user.click(ruleSwitch(editedRule.name));
  await waitFor(() => expect(ruleSwitch(editedRule.name)).not.toBeChecked());
  const toggled = await readRules(transport);
  expect(save).toHaveBeenNthCalledWith(
    3,
    HOST,
    edited.revision,
    [...initial.rules, { ...editedRule, enabled: false }],
    keep
  );

  await user.click(editButton(editedRule.name));
  await user.click(dialog().getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(save).toHaveBeenNthCalledWith(
    4,
    HOST,
    toggled.revision,
    initial.rules,
    keep
  );
  expect(save).toHaveBeenCalledTimes(4);
  expect(rules().queryByRole("switch", { name: editedRule.name })).toBeNull();
  expect(
    rules()
      .getAllByRole("switch")
      .map((row) => row.getAttribute("aria-label"))
  ).toEqual([DISK, MEMORY]);
  expect(rules().getByText("Made by a newer version")).toBeVisible();
});

it("locks all rule controls while one save is pending", async () => {
  const transport = mock();
  const original = transport.setRemoteAlertRules;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(release);
  const save = vi
    .spyOn(transport, "setRemoteAlertRules")
    .mockImplementation(async (...args) => {
      await held;
      return original(...args);
    });
  const { user } = await renderRemote(transport);
  await user.click(await screen.findByRole("switch", { name: DISK }));
  await waitFor(() => expect(ruleSwitch(MEMORY)).toBeDisabled());
  expect(ruleSwitch(DISK)).toBeChecked();
  expect(editButton(DISK)).toBeDisabled();
  expect(newButton()).toBeDisabled();
  release();
  await waitFor(() => expect(ruleSwitch(MEMORY)).toBeEnabled());
  expect(ruleSwitch(DISK)).not.toBeChecked();
  expect(save).toHaveBeenCalledTimes(1);
});

it("reloads after a stale save and keeps the draft for another try", async () => {
  const { user } = await renderRemote(
    mock({ scenarios: ["linux-alerts-stale"] })
  );
  await openNew(user);
  await nameDraft(user, "Pending CPU rule");
  await user.click(saveButton());
  expect((await dialog().findByRole("alert")).textContent).toBe(
    `The rules on ${NAME} changed. The latest rules are loaded; save again to apply your edit.`
  );
  expect(nameInput()).toHaveValue("Pending CPU rule");
  expect(
    await screen.findByText("CPU saturation", { exact: true })
  ).toBeVisible();
  await waitFor(() => expect(saveButton()).toBeEnabled());
  await user.click(saveButton());
  expect(
    await screen.findByRole("switch", { name: "Pending CPU rule" })
  ).toBeChecked();
  expect(ruleSwitch("CPU saturation")).toBeChecked();
});

it("directs a stale toggle back to the rule's switch", async () => {
  const { user } = await renderRemote(
    mock({ scenarios: ["linux-alerts-stale"] })
  );
  await user.click(await screen.findByRole("switch", { name: DISK }));
  expect((await rules().findByRole("alert")).textContent).toBe(
    `The rules on ${NAME} changed. The latest rules are loaded. Use the switch to change the rule.`
  );
  expect(ruleSwitch(DISK)).toBeChecked();
  await user.click(ruleSwitch(DISK));
  await waitFor(() => expect(ruleSwitch(DISK)).not.toBeChecked());
});

it("directs a stale delete back to Delete", async () => {
  const { user } = await renderRemote(
    mock({ scenarios: ["linux-alerts-stale"] })
  );
  await user.click(await screen.findByRole("button", { name: `Edit ${DISK}` }));
  await user.click(dialog().getByRole("button", { name: "Delete" }));
  expect((await dialog().findByRole("alert")).textContent).toBe(
    `The rules on ${NAME} changed. The latest rules are loaded. Click Delete again to remove the rule.`
  );
  expect(nameInput()).toHaveValue(DISK);
  await user.click(dialog().getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(screen.queryByRole("switch", { name: DISK })).not.toBeInTheDocument()
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it.each([
  ["remote_busy", OFFLINE],
  ["internal", "Couldn't load the latest rules."],
] as const)(
  "clears a %s refresh failure when the latest rules are loaded",
  async (kind, notice) => {
    const transport = mock({ scenarios: ["linux-alerts-stale"] });
    const read = transport.remoteAlertRules;
    const save = transport.setRemoteAlertRules;
    let failNextRead = false;
    transport.setRemoteAlertRules = async (...args) => {
      const result = await save(...args);
      failNextRead =
        result.status === "error" &&
        result.error.kind === "remote_rules_changed";
      return result;
    };
    transport.remoteAlertRules = async (...args) => {
      if (!failNextRead) return read(...args);
      failNextRead = false;
      return { status: "error", error: { kind, message: "Read failed" } };
    };
    const { user } = await renderRemote(transport);
    await openNew(user);
    await nameDraft(user, "Pending CPU rule");
    await user.click(saveButton());
    expect(await dialog().findByRole("alert")).toHaveTextContent(notice);
    expect(saveButton()).toBeDisabled();
    await user.click(dialog().getByRole("button", { name: "Reload rules" }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(dialog().queryByRole("alert")).not.toBeInTheDocument();
    expect(nameInput()).toHaveValue("Pending CPU rule");
    await user.click(saveButton());
    expect(
      await screen.findByRole("switch", { name: "Pending CPU rule" })
    ).toBeChecked();
    expect(ruleSwitch("CPU saturation")).toBeChecked();
  }
);

it("keeps the last list readable after disconnecting and reads again on reconnect", async () => {
  const transport = mock({ scenarios: ["linux-alerts-offline"] });
  await renderRemote(transport);
  expect(await screen.findByText(OFFLINE, { exact: true })).toBeVisible();
  expect(await screen.findByRole("switch", { name: DISK })).toBeDisabled();
  expect(editButton(MEMORY)).toBeDisabled();
  expect(newButton()).toBeDisabled();
  expect(rules().getByText("Made by a newer version")).toBeVisible();
  expect(screen.getByRole("button", { name: "Add destination" })).toBeEnabled();
  act(() =>
    transport.pushRemoteStatus(HOST, {
      state: "connected",
      route: "tailscale",
    })
  );
  await waitFor(() => expect(newButton()).toBeEnabled());
  expect(rules().queryByText(OFFLINE, { exact: true })).toBeNull();
  expect(
    transport.calls.filter(({ command }) => command === "remote_alert_rules")
  ).toHaveLength(2);
});

it("shows the disconnected state when the first read cannot reach the host", async () => {
  const transport = mock();
  transport.remoteAlertRules = async () => ({
    status: "error",
    error: {
      kind: "remote_unreachable",
      message: "the host is not connected",
    },
  });
  await renderRemote(transport);
  expect(await rules().findByText(OFFLINE, { exact: true })).toBeVisible();
  expect(rules().queryByRole("switch")).toBeNull();
  expect(newButton()).toBeDisabled();
});

it("keeps a timed-out save open, inline and read-only", async () => {
  const transport = mock();
  transport.setRemoteAlertRules = async () => ({
    status: "error",
    error: {
      kind: "remote_busy",
      message: "the host did not answer in time",
    },
  });
  const { user } = await renderRemote(transport);
  await user.click(await screen.findByRole("button", { name: `Edit ${DISK}` }));
  await nameDraft(user, "Still in the draft");
  await user.click(saveButton());
  expect(await dialog().findByRole("alert")).toHaveTextContent(OFFLINE);
  expect(nameInput()).toHaveValue("Still in the draft");
  expect(saveButton()).toBeDisabled();
  expect(dialog().getByRole("button", { name: "Delete" })).toBeDisabled();
  await user.click(dialog().getByRole("button", { name: "Cancel" }));
  expect(await rules().findByText(OFFLINE, { exact: true })).toBeVisible();
  expect(ruleSwitch(DISK)).toBeDisabled();
});

it("clears lost-connection messages after reading the rules again", async () => {
  const transport = mock();
  transport.setRemoteAlertRules = async () => ({
    status: "error",
    error: { kind: "remote_busy", message: "the host did not answer in time" },
  });
  const { user } = await renderRemote(transport);
  const reconnect = async () => {
    act(() =>
      transport.pushRemoteStatus(HOST, { state: "offline", route: null })
    );
    await screen.findByText("Offline", { exact: true });
    act(() =>
      transport.pushRemoteStatus(HOST, {
        state: "connected",
        route: "tailscale",
      })
    );
  };
  await openNew(user);
  await user.click(saveButton());
  expect(await dialog().findByRole("alert")).toHaveTextContent(OFFLINE);
  await reconnect();
  await waitFor(() => expect(saveButton()).toBeEnabled());
  expect(dialog().queryByRole("alert")).toBeNull();
  await user.click(dialog().getByRole("button", { name: "Cancel" }));
  await user.click(ruleSwitch(DISK));
  expect(await rules().findByText(OFFLINE, { exact: true })).toBeVisible();
  await reconnect();
  await waitFor(() => expect(ruleSwitch(DISK)).toBeEnabled());
  expect(rules().queryByText(OFFLINE, { exact: true })).toBeNull();
});

it.each([
  { kind: "invalid_settings", message: "at most 32 custom rules" },
  { kind: "internal", message: "Saving the alert rules: disk full" },
] as const)("keeps the host’s save rejection inline ($kind)", async (error) => {
  const transport = mock();
  transport.setRemoteAlertRules = async () => ({ status: "error", error });
  const { user } = await renderRemote(transport);
  await openNew(user);
  await nameDraft(user, "Refused draft");
  await user.click(saveButton());
  expect(await dialog().findByRole("alert")).toHaveTextContent(error.message);
  expect(nameInput()).toHaveValue("Refused draft");
  expect(saveButton()).toBeEnabled();
  await user.click(dialog().getByRole("button", { name: "Cancel" }));
  expect(rules().queryByRole("switch", { name: "Refused draft" })).toBeNull();
  expect(rules().getAllByRole("switch")).toHaveLength(2);
});

it("offers the Hosts update action for an older agent and reads its rules after updating", async () => {
  const { user } = await renderRemote(
    mock({ scenarios: ["linux-agent-update"] })
  );
  expect(
    await rules().findByText(`Update the agent on ${NAME} to set alerts`)
  ).toBeVisible();
  expect(newButton()).toBeDisabled();
  await user.click(rules().getByRole("button", { name: /^Update to / }));
  expect(await screen.findByRole("switch", { name: DISK })).toBeEnabled();
  expect(newButton()).toBeEnabled();
});

it.each(["remote_unsupported", "remote_incompatible"] as const)(
  "shows the host’s %s message without an update action when it’s ahead",
  async (kind) => {
    const transport = mock();
    const message =
      "This host answered in a form this StatGlass can't read; update StatGlass on this Mac";
    transport.pushRemoteStatus(HOST, {
      agent_update: { kind: "newer_than_this", installed: "99.0.0" },
    });
    transport.remoteAlertRules = async () => ({
      status: "error",
      error: { kind, message },
    });
    await renderRemote(transport);
    expect(await rules().findByText(message, { exact: true })).toBeVisible();
    expect(rules().queryByRole("button", { name: /Update/ })).toBeNull();
    expect(newButton()).toBeDisabled();
  }
);

it("explains why an agent’s newer rule without an id blocks every edit", async () => {
  const transport = mock();
  const answer = await readRules(transport);
  transport.remoteAlertRules = async () => ({
    status: "ok",
    data: { ...answer, newer: [...answer.newer, { id: null }, { id: null }] },
  });
  await renderRemote(transport);
  expect(
    await rules().findByText(/a rule made by a newer version can’t be kept/)
  ).toBeVisible();
  expect(rules().getAllByText("Made by a newer version")).toHaveLength(3);
  expect(ruleSwitch(DISK)).toBeDisabled();
  expect(editButton(DISK)).toBeDisabled();
  expect(newButton()).toBeDisabled();
});

it("repeats the history-unavailable notice without blocking rule changes", async () => {
  const transport = mock();
  transport.pushRemoteStatus(HOST, { sync: "unavailable" });
  await renderRemote(transport);
  expect(await rules().findByRole("alert")).toHaveTextContent(
    "History is unavailable."
  );
  await waitFor(() => expect(ruleSwitch(DISK)).toBeEnabled());
  expect(newButton()).toBeEnabled();
});

it.each(["changed", "deleted"] as const)(
  "keeps an edit read-only if another Mac has %s the rule",
  async (change) => {
    const transport = mock();
    const { user } = await renderRemote(transport);
    await user.click(
      await screen.findByRole("button", { name: `Edit ${DISK}` })
    );
    await nameDraft(user, "My draft");
    const answer = await readRules(transport);
    const rules = answer.rules.flatMap((rule) => {
      const threshold = rule.when.threshold;
      if (rule.name !== DISK || !threshold) return [rule];
      return change === "deleted"
        ? []
        : [{ ...rule, when: { threshold: { ...threshold, value: 32e9 } } }];
    });
    const external = await transport.setRemoteAlertRules(
      HOST,
      answer.revision,
      rules,
      answer.newer.flatMap(({ id }) => (id ? [id] : []))
    );
    expect(external.status).toBe("ok");
    act(() =>
      transport.pushRemoteStatus(HOST, { state: "offline", route: null })
    );
    await screen.findByText("Offline", { exact: true });
    act(() =>
      transport.pushRemoteStatus(HOST, {
        state: "connected",
        route: "tailscale",
      })
    );
    expect(
      await dialog().findByText(
        `The rules on ${NAME} changed. Reload them and try again. Close this draft to see the latest rules.`
      )
    ).toBeVisible();
    expect(nameInput()).toHaveValue("My draft");
    expect(saveButton()).toBeDisabled();
    expect(dialog().getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(await readRules(transport)).toEqual(
      external.status === "ok" ? external.data : null
    );
  }
);

it("offers an update when a required agent upgrade prevents the handshake", async () => {
  const transport = mock();
  transport.pushRemoteStatus(HOST, {
    state: "error",
    failure_kind: "incompatible",
    agent_update: {
      kind: "required",
      installed: "0.0.9",
      target: "0.1.0",
      via: "push",
    },
  });
  expect(await transport.remoteAlertRules(HOST)).toEqual({
    status: "error",
    error: { kind: "remote_unreachable", message: "the host is not connected" },
  });
  await renderRemote(transport);
  expect(
    await rules().findByText(`Update the agent on ${NAME} to set alerts`)
  ).toBeVisible();
  expect(
    rules().getByRole("button", { name: "Update to 0.1.0" })
  ).toBeEnabled();
  expect(newButton()).toBeDisabled();
});

it("keeps the Linux editor read-only while its remote status is loading", async () => {
  const transport = mock();
  const list = transport.listRemoteHosts;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(release);
  transport.listRemoteHosts = async () => {
    await held;
    return list();
  };
  await renderRemote(transport, false);
  expect(
    await screen.findByRole("heading", { name: `Alerts on ${NAME}` })
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "Alerts" })).toBeVisible();
  expect(screen.queryByRole("switch", { name: /200% CPU/ })).toBeNull();
  expect(newButton()).toBeDisabled();
  await act(async () => release());
  expect(await screen.findByRole("switch", { name: DISK })).toBeEnabled();
});

it("reloads after a timeout while the host still reports connected", async () => {
  const transport = mock();
  transport.setRemoteAlertRules = async () => ({
    status: "error",
    error: { kind: "remote_busy", message: "the host did not answer in time" },
  });
  const { user } = await renderRemote(transport);
  await openNew(user);
  await nameDraft(user, "My draft");
  await user.click(saveButton());
  expect(await dialog().findByRole("alert")).toHaveTextContent(OFFLINE);
  await user.click(dialog().getByRole("button", { name: "Reload rules" }));
  await waitFor(() => expect(saveButton()).toBeEnabled());
  expect(nameInput()).toHaveValue("My draft");
  expect(dialog().queryByRole("alert")).toBeNull();
});

it("shows a delete refusal when the discarded edit has invalid fields", async () => {
  const transport = mock();
  transport.setRemoteAlertRules = async () => ({
    status: "error",
    error: { kind: "internal", message: "Saving the alert rules: disk full" },
  });
  const { user } = await renderRemote(transport);
  await user.click(await screen.findByRole("button", { name: `Edit ${DISK}` }));
  await user.clear(nameInput());
  expect(saveButton()).toBeDisabled();
  await user.click(dialog().getByRole("button", { name: "Delete" }));
  expect(
    await dialog().findByText("Saving the alert rules: disk full")
  ).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Edit rule" })).toBeVisible();
});

it("keeps an inclusive agent comparison when renaming its rule", async () => {
  const transport = mock();
  const answer = await readRules(transport);
  const [disk] = answer.rules;
  const threshold = disk?.when.threshold;
  if (!disk || !threshold) throw new Error("Missing disk rule");
  const inclusive = await transport.setRemoteAlertRules(
    HOST,
    answer.revision,
    [{ ...disk, when: { threshold: { ...threshold, op: "le" } } }],
    []
  );
  expect(inclusive.status).toBe("ok");
  const { user } = await renderRemote(transport);
  await user.click(await screen.findByRole("button", { name: `Edit ${DISK}` }));
  await nameDraft(user, "Disk watch");
  await user.click(saveButton());
  await screen.findByRole("switch", { name: "Disk watch" });
  expect((await readRules(transport)).rules[0]?.when.threshold?.op).toBe("le");
});

it("freezes a draft while its metric dropdown is already open on disconnect", async () => {
  const transport = mock();
  const { user } = await renderRemote(transport);
  await openNew(user);
  await user.click(dialog().getByRole("combobox", { name: "Metric" }));
  act(() =>
    transport.pushRemoteStatus(HOST, { state: "offline", route: null })
  );
  await screen.findByText("Offline", { exact: true });
  await user.click(screen.getByRole("option", { name: "Memory stall" }));
  expect(dialog().getByRole("combobox", { name: "Metric" })).toHaveTextContent(
    "CPU usage"
  );
});
