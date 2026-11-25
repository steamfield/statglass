import type { PairedHost } from "@core/generated/types";
import { hostKeys } from "@core/query-keys";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useEffectEvent } from "react";
import { ActivityIndicator } from "react-native";
import { usePhoneSettingsActions } from "@/data/phone-settings";
import { useSetPhoneTransport } from "@/data/transport-context";
import { useNativeCore, useNativeCoreStarting } from "@/transport";
import { ScreenScroll } from "@/ui/screen-scroll";
import { StartupFailurePanel } from "@/ui/startup-failure";
import { Text } from "@/ui/text";
import { afterPair } from "./after-pair";
import { usePairingFlow } from "./flow";
import { PairAction } from "./screens/action";
import { ChooseMethod } from "./screens/choose-method";
import { PairingStep } from "./screens/pairing-step";
import { Paste } from "./screens/paste";
import { Preview } from "./screens/preview";
import { PairingFailure, PairingSuccess } from "./screens/result";
import { Scanner } from "./screens/scanner";
import { Waiting } from "./screens/waiting";

export function PairScreen() {
  const router = useRouter();
  const { core, error } = useNativeCore();
  const starting = useNativeCoreStarting();
  const selectTransport = useSetPhoneTransport();
  const cache = useQueryClient();
  const { set } = usePhoneSettingsActions();

  const complete = useCallback(
    (result: PairedHost, demo: boolean) => {
      if (demo) {
        router.replace("/demo");
        return;
      }
      if (core) {
        selectTransport(core, false);
        set((settings) =>
          settings.removed.includes(result.id)
            ? { removed: settings.removed.filter((host) => host !== result.id) }
            : settings
        );
        void cache.invalidateQueries({ queryKey: hostKeys.all });
      }
      afterPair(router, result);
    },
    [cache, core, router, selectTransport, set]
  );

  function done() {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  // A started core keeps the flow mounted: a successful pair announces the
  // new roster before the flow reaches its paired step, and the brief
  // hosts-but-no-transport window must not unmount and reset it.
  const waiting = starting && core === null;
  if (waiting || error) {
    return (
      <ScreenScroll
        className="flex-1 bg-background"
        contentContainerClassName="px-6 pt-4 pb-safe-or-6"
      >
        {waiting ? (
          <Text variant="body">Starting StatGlass…</Text>
        ) : (
          <StartupFailurePanel />
        )}
      </ScreenScroll>
    );
  }
  return <PairingFlow onPaired={complete} onDone={done} />;
}

/** The pairing steps can run with an injected provider and no navigation stack. */
export function PairingFlow({
  onPaired,
  onDone,
}: {
  onPaired(result: PairedHost, demo: boolean): void;
  onDone(): void;
}) {
  const { step, choose, inspect, confirm, setCamera, cancel } =
    usePairingFlow();

  const finishNativePairing = useEffectEvent((host: PairedHost) =>
    onPaired(host, false)
  );
  useEffect(() => {
    if (step.kind === "paired" && !step.demo) finishNativePairing(step.result);
  }, [step]);

  function renderStep() {
    switch (step.kind) {
      case "idle":
        return (
          <ChooseMethod
            scan={() => choose("scan")}
            paste={() => choose("paste")}
          />
        );
      case "scanning":
        return (
          <Scanner
            camera={step.camera}
            setCamera={setCamera}
            inspect={(code) => void inspect("scan", code)}
            paste={() => choose("paste")}
            cancel={cancel}
          />
        );
      case "pasting":
        return (
          <Paste
            inspect={(code) => void inspect("paste", code)}
            cancel={cancel}
          />
        );
      case "checking":
        return (
          <PairingStep
            title="Reading pairing code…"
            actions={<PairAction label="Cancel" secondary onPress={cancel} />}
          >
            <ActivityIndicator accessibilityLabel="Reading pairing code" />
          </PairingStep>
        );
      case "previewing":
        return (
          <Preview offer={step.preview} confirm={confirm} cancel={cancel} />
        );
      case "waiting":
        return (
          <Waiting
            host={step.preview.name}
            code={step.preview.code}
            cancel={cancel}
          />
        );
      case "paired":
        return (
          <PairingSuccess
            host={step.result.name}
            done={() => onPaired(step.result, step.demo)}
          />
        );
      case "failed":
        return (
          <PairingFailure
            step={step}
            retry={() => choose(step.method)}
            done={onDone}
          />
        );
    }
  }

  return renderStep();
}
