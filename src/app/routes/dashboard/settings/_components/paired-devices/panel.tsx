import { commandErrorText } from "@core/command-error";
import { formatDateTime } from "@core/format";
import type { PairedDeviceInfo } from "@core/generated/types";
import { unwrap } from "@core/transport";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { InlineMessage } from "~/components/inline-message";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import { useTransport } from "~/lib/transport-context";
import { DeviceIntents } from "../device-intents";
import { UpdateFromMac } from "../update-from-mac";
import { PairingDialog } from "./pairing-dialog";

const devicesKey = ["paired-devices"] as const;

function deviceName(device: PairedDeviceInfo): string {
  return device.name.trim() || `iPhone ${device.tag}`;
}

function deviceLabel(
  device: PairedDeviceInfo,
  devices: readonly PairedDeviceInfo[]
): string {
  const name = deviceName(device);
  return devices.some(
    (other) => other.tag !== device.tag && deviceName(other) === name
  )
    ? `${name} (${device.tag})`
    : name;
}

export function PairedDevicesPanel() {
  const transport = useTransport();
  const client = useQueryClient();
  const [selected, setSelected] = useState<{
    tag: string;
    label: string;
  } | null>(null);
  const devices = useQuery({
    queryKey: devicesKey,
    queryFn: () => unwrap(transport.pairedDevices()),
  });
  const refresh = () => client.invalidateQueries({ queryKey: devicesKey });
  const revoke = useMutation({
    mutationFn: (tag: string) => unwrap(transport.revokeDevice(tag)),
    onSuccess: async () => {
      await refresh();
      setSelected(null);
    },
  });

  return (
    <SettingsPanel id="iphones" title="iPhones">
      <SettingsRow
        id="iphone-access"
        label="iPhone access"
        sub="iPhones you approve can read metrics from this Mac and the hosts you share with them."
      >
        <PairingDialog onPaired={() => void refresh()} />
      </SettingsRow>
      {devices.isPending && (
        <InlineMessage tone="status" className="px-4 py-3">
          Loading paired devices…
        </InlineMessage>
      )}
      {devices.isError && (
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <InlineMessage tone="error">
            {commandErrorText(devices.error, "Couldn’t read paired devices.")}
          </InlineMessage>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void devices.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {devices.data?.length === 0 && (
        <InlineMessage tone="status" className="px-4 py-3">
          No paired devices.
        </InlineMessage>
      )}
      {devices.data?.map((device, _, list) => {
        const label = deviceLabel(device, list);
        return (
          <SettingsRow
            key={device.tag}
            label={label}
            sub={
              <span title={device.fingerprint} className="figures">
                {device.last_seen_ms === null
                  ? "Never connected"
                  : `Last seen ${formatDateTime(device.last_seen_ms)}`}
              </span>
            }
          >
            <Button
              variant="outline"
              size="sm"
              aria-label={`Revoke ${label}`}
              onClick={() => {
                revoke.reset();
                setSelected({ tag: device.tag, label });
              }}
            >
              Revoke
            </Button>
          </SettingsRow>
        );
      })}
      <DeviceIntents />
      <UpdateFromMac />
      {selected && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
          title={`Revoke ${selected.label}?`}
          description="StatGlass removes access on this Mac and queues removal on the hosts it shared with this iPhone. This iPhone will need to pair again to reconnect. A phone that's already connected stays connected until it disconnects."
          confirmLabel="Revoke access"
          confirmVariant="destructive"
          onConfirm={() => revoke.mutate(selected.tag)}
          busy={revoke.isPending}
          lockWhileBusy
        >
          {revoke.isError && (
            <InlineMessage tone="error">
              {commandErrorText(revoke.error, "Couldn’t revoke this device.")}
            </InlineMessage>
          )}
        </ConfirmDialog>
      )}
    </SettingsPanel>
  );
}
