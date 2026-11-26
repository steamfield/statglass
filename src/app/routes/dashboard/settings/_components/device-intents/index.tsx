import { commandErrorText } from "@core/command-error";
import type { DeviceIntentInfo } from "@core/generated/types";
import { unwrap } from "@core/transport";
import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { InlineMessage } from "~/components/inline-message";
import { SettingsRow } from "~/components/settings-row";
import { Button } from "~/components/ui/button";
import { useTransport } from "~/lib/transport-context";
import { useDeviceIntents } from "../../_hooks/use-device-intents";

function IntentRow({ intent }: { intent: DeviceIntentInfo }) {
  const operation = intent.op === "revoke" ? "Revoke" : "Install";
  const state = intent.state === "failed" ? "failed" : "pending";
  return (
    <SettingsRow
      part="device-access"
      label={intent.host_name}
      sub={
        <span className="wrap-anywhere">
          {operation} {state} · {intent.device_name}
          {intent.reason && <span className="block">{intent.reason}</span>}
        </span>
      }
    />
  );
}

export function DeviceIntents() {
  const transport = useTransport();
  const intents = useDeviceIntents();
  const retry = useMutation({
    mutationFn: () => unwrap(transport.retryDeviceIntents()),
    onSettled: () => intents.refetch(),
  });
  const hasIntents = Boolean(intents.data?.length);
  const { reset } = retry;
  useEffect(() => {
    if (intents.data?.length === 0) reset();
  }, [intents.data, reset]);
  return (
    <>
      <SettingsRow
        id="device-access"
        label="Device access on other hosts"
        sub={
          intents.isPending ? (
            <span role="status">Loading device updates…</span>
          ) : hasIntents ? (
            "This Mac applies changes when it can reach each host."
          ) : !intents.isError ? (
            "No pending device updates."
          ) : undefined
        }
      >
        {(intents.isError || hasIntents) && (
          <Button
            variant="outline"
            size="sm"
            aria-label="Retry device updates"
            disabled={intents.isFetching || retry.isPending}
            onClick={() => {
              if (intents.isError) void intents.refetch();
              else retry.mutate();
            }}
          >
            {retry.isPending ? "Retrying…" : "Retry"}
          </Button>
        )}
      </SettingsRow>
      {intents.isError && (
        <div data-settings-part="device-access" className="px-4 py-3">
          <InlineMessage tone="error">
            {commandErrorText(intents.error, "Couldn’t read device updates.")}
          </InlineMessage>
        </div>
      )}
      {retry.isError && hasIntents && (
        <div data-settings-part="device-access" className="px-4 py-3">
          <InlineMessage tone="error">
            {commandErrorText(retry.error, "Couldn’t retry device updates.")}
          </InlineMessage>
        </div>
      )}
      {intents.data?.map((intent) => (
        <IntentRow key={`${intent.host}/${intent.device}`} intent={intent} />
      ))}
    </>
  );
}
