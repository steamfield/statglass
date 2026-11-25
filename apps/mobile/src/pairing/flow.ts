import { commandError, commandErrorText } from "@core/command-error";
import type {
  CommandError,
  PairedHost,
  PairingPreview,
} from "@core/generated/types";
import { isNativeError, type NativeError } from "@core/native-errors";
import type { CommandResult } from "@core/transport";
import { deviceName, modelName } from "expo-device";
import { useCallback, useEffect, useRef, useState } from "react";
import { isDemoPairingCode, usePhonePairing } from "@/data/pairing-context";

type Method = "scan" | "paste";
export type CameraStep = "priming" | "granted" | "denied" | "unavailable";
type PairingError = CommandError | NativeError;

type Offer = {
  method: Method;
  text: string;
  preview: PairingPreview;
};

export type PairingStep =
  | { kind: "idle" }
  | { kind: "scanning"; camera: CameraStep }
  | { kind: "pasting" }
  | { kind: "checking" }
  | ({ kind: "previewing" | "waiting" } & Offer)
  | { kind: "paired"; result: PairedHost; demo: boolean }
  | { kind: "failed"; method: Method; host?: string; error: PairingError };

const IDLE = { kind: "idle" } as const;

function pairingError(error: unknown): PairingError {
  if (isNativeError(error)) return error;
  return (
    commandError(error) ?? {
      kind: "internal",
      message: commandErrorText(error, "StatGlass couldn’t complete pairing."),
    }
  );
}

/** Local state for one offer. Leaving a step abandons its pending reply. */
export function usePairingFlow() {
  const pairing = usePhonePairing();
  const [step, setStep] = useState<PairingStep>(IDLE);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  function go(next: PairingStep) {
    inFlight.current?.abort();
    inFlight.current = null;
    setStep(next);
  }

  function choose(method: Method) {
    go(
      method === "scan"
        ? { kind: "scanning", camera: "priming" }
        : { kind: "pasting" }
    );
  }

  const setCamera = useCallback((camera: CameraStep) => {
    setStep((current) =>
      current.kind === "scanning" ? { kind: "scanning", camera } : current
    );
  }, []);

  async function run<T>(
    request: (signal: AbortSignal) => Promise<CommandResult<T>>,
    next: PairingStep,
    failure: { method: Method; host?: string },
    success: (data: T) => PairingStep
  ) {
    if (inFlight.current) return;
    const action = new AbortController();
    inFlight.current = action;
    setStep(next);
    try {
      const result = await request(action.signal);
      if (action.signal.aborted) return;
      setStep(
        result.status === "ok"
          ? success(result.data)
          : { kind: "failed", ...failure, error: result.error }
      );
    } catch (error) {
      if (action.signal.aborted) return;
      setStep({ kind: "failed", ...failure, error: pairingError(error) });
    } finally {
      if (inFlight.current === action) inFlight.current = null;
    }
  }

  function inspect(method: Method, text: string) {
    return run<PairingPreview>(
      () =>
        text.startsWith("SGP1:") || isDemoPairingCode(text)
          ? pairing.previewPairing(text)
          : Promise.resolve({
              status: "error",
              error: { kind: "pairing", reason: "invalid", message: "" },
            }),
      { kind: "checking" },
      { method },
      (preview) => ({ kind: "previewing", method, text, preview })
    );
  }

  function confirm() {
    if (step.kind !== "previewing") return;
    const { method, text, preview } = step;
    void run<PairedHost>(
      (signal) =>
        preview.expires_ms <= Date.now()
          ? Promise.resolve({
              status: "error",
              error: { kind: "pairing", reason: "expired", message: "" },
            })
          : pairing.pair(
              text,
              deviceName ?? "iPhone",
              modelName ?? "iPhone",
              signal
            ),
      { ...step, kind: "waiting" },
      { method, host: preview.name },
      (result) => ({ kind: "paired", result, demo: isDemoPairingCode(text) })
    );
  }

  return { step, choose, inspect, confirm, setCamera, cancel: () => go(IDLE) };
}
