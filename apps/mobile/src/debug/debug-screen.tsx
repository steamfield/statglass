/**
 * The phase 4 debug screen: connects the native core to one host with a key
 * installed by hand and shows its live CPU. Reached at `statglass://debug`.
 */
import { formatPercent } from "@core/format";
import type {
  HostId,
  RemoteHostStatus,
  RemoteRoute,
} from "@core/generated/types";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { hostStatusLabel } from "@/data/hosts";
import {
  connectionStatusError,
  useHostLive,
  useHostLiveSubscription,
  useLastFrame,
  useLiveFailure,
  useRemoteStatus,
} from "@/data/live";
import type { NativeTransport } from "@/transport";
import { StartupFailurePanel } from "@/ui/startup-failure";
import { Text } from "@/ui/text";
import { type DebugHostFields, debugHost } from "./debug-host";
import { useDebugConnection } from "./use-debug-connection";
import { useDebugCore } from "./use-debug-core";

const FIELDS = [
  { name: "address", label: "Address" },
  { name: "user", label: "SSH user" },
  { name: "port", label: "SSH port (optional)" },
  { name: "helper", label: "Helper path (optional)" },
  { name: "hostId", label: "StatGlass host ID" },
  { name: "hostKey", label: "SSH host key pin" },
] as const;

const ROUTES: { label: string; value: RemoteRoute }[] = [
  { label: "LAN", value: "lan" },
  { label: "Tailscale", value: "tailscale" },
];

const DEVELOPMENT_BUILD = "The debug screen needs a development build.";

/** Host form, the phone's `authorized_keys` line, connection state and live CPU. */
export function DebugScreen() {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <View className="gap-4 px-4 pt-2 pb-safe-or-4">
        {__DEV__ ? (
          <DebugCoreContent />
        ) : (
          <Text role="body">{DEVELOPMENT_BUILD}</Text>
        )}
      </View>
    </ScrollView>
  );
}

function DebugCoreContent() {
  const core = useDebugCore();
  switch (core.status) {
    case "loading":
      return <Text role="body">Reading the iPhone’s SSH key…</Text>;
    case "missing":
      return <Text role="body">{DEVELOPMENT_BUILD}</Text>;
    case "error":
      return <ErrorText>{core.message}</ErrorText>;
    case "ready":
      return (
        <DebugHostForm transport={core.transport} keyLine={core.keyLine} />
      );
    case "startup-error":
      return <StartupFailurePanel />;
  }
}

function DebugHostForm({
  transport,
  keyLine,
}: {
  transport: NativeTransport;
  keyLine: string;
}) {
  const [fields, setFields] = useState<DebugHostFields>(() => ({
    address: process.env.EXPO_PUBLIC_STATGLASS_DEBUG_HOST ?? "",
    user: process.env.EXPO_PUBLIC_STATGLASS_DEBUG_USER ?? "",
    port: process.env.EXPO_PUBLIC_STATGLASS_DEBUG_PORT ?? "",
    helper: process.env.EXPO_PUBLIC_STATGLASS_DEBUG_HELPER ?? "",
    route: "lan",
    hostId: "",
    hostKey: "",
  }));
  const [formError, setFormError] = useState<string | null>(null);
  const connection = useDebugConnection(transport);
  const { attempt, busy, error } = connection;

  function connect() {
    if (busy) return;
    setFormError(null);
    try {
      void connection.connect(debugHost(fields));
    } catch (error) {
      if (error instanceof Error) setFormError(error.message);
      else throw error;
    }
  }

  return (
    <>
      <View className="gap-2 rounded-xl border border-border bg-card p-3">
        <Text role="cardTitle">authorized_keys</Text>
        <Text role="label">
          Add this line to ~/.ssh/authorized_keys on the Mac.
        </Text>
        <Text role="body" selectable>
          {keyLine}
        </Text>
      </View>
      <View className="gap-3">
        {FIELDS.map(({ name, label }) => (
          <View key={name} className="gap-1">
            <Text role="label">{label}</Text>
            <TextInput
              accessibilityLabel={label}
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-[44px] rounded-xl border border-border bg-card px-3 py-2 text-[17px] text-foreground"
              keyboardType={name === "port" ? "number-pad" : "default"}
              multiline={name === "hostKey"}
              onChangeText={(value) =>
                setFields((current) => ({ ...current, [name]: value }))
              }
              value={fields[name]}
            />
            {name === "hostKey" && (
              <Text role="caption">
                For example, ssh-ed25519 followed by the SHA256 fingerprint.
              </Text>
            )}
          </View>
        ))}
        <View className="gap-1">
          <Text role="label">Route</Text>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Route"
            className="overflow-hidden rounded-xl border border-border bg-card"
          >
            {ROUTES.map(({ label, value }, index) => (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityLabel={label}
                accessibilityState={{ checked: fields.route === value }}
                className={`min-h-[44px] flex-row items-center justify-between gap-3 px-4 py-2 active:bg-secondary ${index ? "border-border-subtle border-t" : ""}`}
                onPress={() =>
                  setFields((current) => ({ ...current, route: value }))
                }
              >
                <Text role="body" className="shrink">
                  {label}
                </Text>
                {fields.route === value && (
                  <Text role="body" className="text-link" accessible={false}>
                    ✓
                  </Text>
                )}
              </Pressable>
            ))}
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Connect"
          accessibilityState={{ disabled: busy, busy }}
          className="min-h-[44px] items-center justify-center rounded-xl bg-primary px-4 py-2 active:opacity-70 disabled:opacity-50"
          disabled={busy}
          onPress={connect}
        >
          <Text role="body" className="font-semibold text-primary-foreground!">
            Connect
          </Text>
        </Pressable>
        {formError && <ErrorText>{formError}</ErrorText>}
      </View>
      {attempt ? (
        <DebugReading key={attempt.number} host={attempt.host} error={error} />
      ) : (
        <ConnectionReading
          label={busy ? "Connecting" : connectionStatus(false, error)}
          error={error}
          cpu={null}
        />
      )}
    </>
  );
}

function useDebugCpu(
  host: HostId,
  state: RemoteHostStatus["state"] | undefined,
  statusFailed: boolean
) {
  const lastFrame = useLastFrame(host);
  const cpu = useHostLive(host, (state) => state.held["cpu.total"] ?? null);
  const connected = state === "connected";
  const [display, setDisplay] = useState({ state, hiddenFrame: lastFrame });
  const unavailable =
    statusFailed ||
    (state !== undefined && state !== "connecting" && !connected);
  if (
    display.state !== state ||
    (unavailable && display.hiddenFrame !== lastFrame)
  ) {
    // Keep startup frames received while connecting. Hide readings from a
    // session that has since disconnected until a new frame arrives.
    const hide = (display.state === "connected" && !connected) || unavailable;
    setDisplay({ state, hiddenFrame: hide ? lastFrame : display.hiddenFrame });
  }
  return display.hiddenFrame === lastFrame ? null : cpu;
}

function DebugReading({ host, error }: { host: HostId; error: string | null }) {
  useHostLiveSubscription(host);
  const status = useRemoteStatus(host);
  const failure = useLiveFailure(host);
  const recovering = useHostLive(
    host,
    (state) => state.stale || state.connection === "reconnecting"
  );
  const remote = status.isError ? undefined : status.data;
  const connected = remote?.state === "connected";
  const cpu = useDebugCpu(host, remote?.state, status.isError);
  const readError = status.isError ? connectionStatusError(status.error) : null;
  const problem = error ?? readError ?? remote?.error ?? failure;
  const live = connected && !recovering;
  const label = remote
    ? hostStatusLabel(false, remote).text
    : connectionStatus(true, problem);
  return (
    <ConnectionReading
      label={connected && recovering ? "Reconnecting" : label}
      error={problem}
      cpu={live ? cpu : null}
      connected={live}
    />
  );
}

function ConnectionReading({
  label,
  error,
  cpu,
  connected = false,
}: {
  label: string;
  error: string | null;
  cpu: number | null;
  connected?: boolean;
}) {
  return (
    <View className="gap-1 rounded-xl border border-border bg-card p-3">
      <View className="flex-row items-center gap-2">
        {connected && <View className="size-1.5 rounded-full bg-live" />}
        <Text role="label" className="shrink">
          {label}
        </Text>
      </View>
      {error && <ErrorText>{error}</ErrorText>}
      <Text role="label">CPU</Text>
      {/** The NativeWind converter drops CSS font-variant-numeric. */}
      <Text role="cardFigure" style={{ fontVariant: ["tabular-nums"] }}>
        {formatPercent(cpu)}
      </Text>
    </View>
  );
}

function connectionStatus(hasAttempt: boolean, error: string | null) {
  if (error !== null) return "Connection failed";
  return hasAttempt ? "Connecting" : "Disconnected";
}

function ErrorText({ children }: { children: string | null | undefined }) {
  return (
    <Text role="label" accessibilityRole="alert" className="text-destructive!">
      {children}
    </Text>
  );
}
