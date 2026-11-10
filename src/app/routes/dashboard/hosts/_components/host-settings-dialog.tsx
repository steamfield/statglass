import { formatBytes } from "@core/format";
import type { RemoteHostRecord } from "@core/generated/bindings";
import { useId } from "react";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { InlineMessage } from "~/components/inline-message";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { TruncatedText } from "~/components/truncated-text";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { useHostSelection } from "~/lib/host-selection";
import { MeterTrack } from "~/widgets/meter-track";
import { useHostSettings } from "../_hooks/use-host-settings";
import { remoteHostCardModel } from "../_lib/host-card-model";
import { HostCardActions } from "./host-card-actions";
import { HostCardStatus } from "./host-card-status";
import { HostCardVersion } from "./host-card-version";
import { HOST_INPUT } from "./host-input";
import { RemoteSetupError } from "./remote-setup-error";
import { RemoteUpdateSettings } from "./remote-update-settings";
import { RemoveHostOptions } from "./remove-host-options";
import { SshSetupHelp } from "./ssh-setup-help";

type Controller = ReturnType<typeof useHostSettings>;

function ConnectionSettings({ settings }: { settings: Controller }) {
  const id = useId();
  const { config, setConfig } = settings;
  const fields = [
    { key: "name", label: "Name", sub: "", value: config.name },
    {
      key: "lan",
      label: "LAN SSH alias",
      sub: "Tried first on the same network",
      value: config.lan ?? "",
    },
    {
      key: "tailscale",
      label: "Tailscale SSH alias",
      sub: "Used from anywhere on your tailnet",
      value: config.tailscale ?? "",
    },
  ] satisfies {
    key: "name" | "lan" | "tailscale";
    label: string;
    sub: string;
    value: string;
  }[];
  return (
    <SettingsPanel title="Connection">
      {fields.map((field) => (
        <SettingsRow
          key={field.key}
          label={field.label}
          sub={field.sub}
          htmlFor={`${id}-${field.key}`}
        >
          <input
            id={`${id}-${field.key}`}
            className={`${HOST_INPUT} max-w-60`}
            value={field.value}
            onChange={(event) =>
              setConfig({
                ...config,
                [field.key]:
                  field.key === "name"
                    ? event.target.value
                    : event.target.value || null,
              })
            }
          />
        </SettingsRow>
      ))}
      <SettingsRow
        label="Connect automatically"
        sub="Off stops retries. History already copied stays here"
      >
        <Switch
          aria-label="Connect automatically"
          checked={config.enabled}
          onCheckedChange={(enabled) => setConfig({ ...config, enabled })}
        />
      </SettingsRow>
    </SettingsPanel>
  );
}

function HistorySettings({ settings }: { settings: Controller }) {
  const id = useId();
  const { size, config, setConfig, validBudget } = settings;
  const budget = config.mirror_budget_mb * 1_000_000;
  const usage =
    size.data === undefined
      ? size.isError
        ? "Unavailable"
        : "Loading…"
      : `${formatBytes(size.data, { unit: "MB" })} of ${formatBytes(budget, { unit: "MB" })}`;
  return (
    <SettingsPanel
      title="History on this Mac"
      after={
        !validBudget && (
          <InlineMessage tone="error">
            Enter a whole number from 10 to 10,000 MB.
          </InlineMessage>
        )
      }
    >
      <SettingsRow label="Mirrored copy" sub={usage}>
        <MeterTrack
          fraction={
            size.data === undefined || !validBudget ? null : size.data / budget
          }
          fill="var(--color-fg-subtle)"
          height="h-1.5"
          className="w-40"
        />
      </SettingsRow>
      <SettingsRow
        label="Size limit"
        sub="10 to 10,000 MB. The oldest history goes first"
        htmlFor={id}
      >
        <div className="flex items-center gap-2">
          <input
            id={id}
            className={`${HOST_INPUT} figures max-w-24 text-right`}
            type="number"
            min="10"
            max="10000"
            value={
              Number.isNaN(config.mirror_budget_mb)
                ? ""
                : config.mirror_budget_mb
            }
            onChange={(event) =>
              setConfig({
                ...config,
                mirror_budget_mb:
                  event.target.value === ""
                    ? Number.NaN
                    : Number(event.target.value),
              })
            }
          />
          <span className="text-muted-foreground text-small">MB</span>
        </div>
      </SettingsRow>
    </SettingsPanel>
  );
}

export function HostSettingsDialog({
  remote,
  close,
}: {
  remote: RemoteHostRecord;
  close: () => void;
}) {
  const settings = useHostSettings(remote, close);
  const selection = useHostSelection();
  const model = remoteHostCardModel(
    remote,
    selection?.hosts.find((host) => host.id === remote.config.id)
  );
  const {
    config,
    busy,
    removing,
    setRemoving,
    linux,
    error,
    endpointError,
    named,
    validBudget,
    run,
  } = settings;
  return (
    <>
      <Dialog
        open={!removing}
        onOpenChange={(open) => {
          if (!open && !busy) close();
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          className="flex max-h-[calc(100svh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        >
          <header className="flex flex-col gap-2 border-border-subtle border-b px-5 py-4 pr-12">
            <DialogTitle>
              <TruncatedText text={config.name} />
            </DialogTitle>
            <DialogDescription asChild>
              <div>
                <HostCardStatus
                  model={{
                    ...model,
                    route: [model.route, model.system]
                      .filter(Boolean)
                      .join(" · "),
                  }}
                />
              </div>
            </DialogDescription>
          </header>
          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
            <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
              <ConnectionSettings settings={settings} />
              <HistorySettings settings={settings} />
              <div className="relative pt-5 sm:pt-0">
                <p className="absolute top-0 right-0 font-normal text-label text-muted-foreground">
                  Saved on the host as you change them
                </p>
                <SettingsPanel title="Updates on this host">
                  <SettingsRow
                    label="StatGlass"
                    sub={<HostCardVersion version={model.version} />}
                  >
                    <HostCardActions
                      connectionActions={false}
                      model={model}
                      remote={remote}
                    />
                  </SettingsRow>
                  <RemoteUpdateSettings
                    hostId={remote.config.id}
                    disabled={busy}
                  />
                </SettingsPanel>
              </div>
              <SettingsPanel title="Remove">
                <SettingsRow
                  label="Remove host"
                  sub={
                    linux
                      ? "Disconnects it. You choose next whether to uninstall the agent and delete copied history"
                      : "Disconnects it. You choose next whether to stop sharing and delete copied history"
                  }
                >
                  <Button variant="outline" onClick={() => setRemoving(true)}>
                    Remove…
                  </Button>
                </SettingsRow>
              </SettingsPanel>
            </fieldset>
            {endpointError && (
              <InlineMessage tone="error">{endpointError}</InlineMessage>
            )}
            {error && <RemoteSetupError error={error} />}
            <SshSetupHelp
              saved
              lan={config.lan}
              tailscale={config.tailscale}
              busy={busy}
            />
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-border-subtle border-t px-5 py-3">
            <Button variant="ghost" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={busy || !named || !validBudget || !!endpointError}
              onClick={() => void run(false)}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(false);
        }}
        title={`Remove ${config.name}?`}
        description={
          linux
            ? "This disconnects the server. Unless you uninstall it, the agent keeps running and recording history there."
            : "This disconnects the Mac. StatGlass on that Mac keeps running and its start-at-login setting stays the same."
        }
        cancelLabel="Back"
        confirmLabel={busy ? "Saving…" : "Remove host"}
        confirmDisabled={!named}
        onConfirm={() => void run(true)}
        busy={busy}
        lockWhileBusy
      >
        <RemoveHostOptions
          linux={linux}
          choices={settings.choices}
          setChoices={settings.setChoices}
          busy={busy}
        />
        {error && <RemoteSetupError error={error} />}
      </ConfirmDialog>
    </>
  );
}
