import { Camera, CameraView } from "expo-camera";
import { isDevice } from "expo-device";
import { useEffect, useRef, useState } from "react";
import { AppState, Linking, View } from "react-native";
import type { CameraStep } from "@/pairing/flow";
import { Text } from "@/ui/text";
import { PairAction } from "./action";

const PERMISSION_STEPS = {
  granted: "granted",
  denied: "denied",
  undetermined: "priming",
} as const;

export function Scanner({
  camera,
  setCamera,
  inspect,
  paste,
  cancel,
}: {
  camera: CameraStep;
  setCamera(step: CameraStep): void;
  inspect(code: string): void;
  paste(): void;
  cancel(): void;
}) {
  return (
    <>
      {!isDevice || camera === "unavailable" ? (
        <>
          <Text role="title">Camera is unavailable</Text>
          <Text role="body">
            Paste the pairing code from the host to continue.
          </Text>
        </>
      ) : (
        <CameraScanner
          camera={camera}
          setCamera={setCamera}
          inspect={inspect}
        />
      )}
      <PairAction label="Paste code" secondary onPress={paste} />
      <PairAction label="Cancel" secondary onPress={cancel} />
    </>
  );
}

function CameraScanner({
  camera,
  setCamera,
  inspect,
}: {
  camera: Exclude<CameraStep, "unavailable">;
  setCamera(step: CameraStep): void;
  inspect(code: string): void;
}) {
  const [requesting, setRequesting] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const captured = useRef(false);
  const view = useRef<CameraView>(null);
  const active = useRef(false);
  const permissionPending = useRef(false);

  useEffect(() => {
    active.current = true;
    async function refreshPermission() {
      try {
        const permission = await Camera.getCameraPermissionsAsync();
        if (!active.current || permissionPending.current) return;
        setCamera(PERMISSION_STEPS[permission.status]);
      } catch (error) {
        console.warn("[pairing] Could not read camera permission", error);
        if (active.current) setCamera("unavailable");
      }
    }

    void refreshPermission();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshPermission();
    });
    return () => {
      active.current = false;
      subscription.remove();
    };
  }, [setCamera]);

  useEffect(() => {
    if (camera !== "granted" || !view.current) return;
    let active = true;
    void view.current
      .getAvailableLensesAsync()
      .then((lenses) => {
        if (active && lenses.length === 0) setCamera("unavailable");
      })
      .catch((error: unknown) => {
        console.warn("[pairing] Could not read available camera lenses", error);
        if (active) setCamera("unavailable");
      });
    return () => {
      active = false;
    };
  }, [camera, setCamera]);

  async function request() {
    if (permissionPending.current) return;
    permissionPending.current = true;
    setRequesting(true);
    try {
      const result = await Camera.requestCameraPermissionsAsync();
      if (active.current) setCamera(result.granted ? "granted" : "denied");
    } catch (error) {
      console.warn("[pairing] Could not request camera permission", error);
      if (active.current) setCamera("unavailable");
    } finally {
      permissionPending.current = false;
      if (active.current) setRequesting(false);
    }
  }

  async function openSettings() {
    try {
      await Linking.openSettings();
    } catch (error) {
      console.warn("[pairing] Could not open Settings", error);
      setSettingsError(true);
    }
  }

  if (camera === "denied") {
    return (
      <>
        <Text role="title">Camera access is off</Text>
        <Text role="body">
          Allow camera access for StatGlass in Settings to scan a pairing code.
        </Text>
        <PairAction label="Open Settings" onPress={openSettings} />
        {settingsError && (
          <Text role="caption" accessibilityRole="alert">
            Couldn’t open Settings. Open it from the Home Screen or paste the
            code.
          </Text>
        )}
      </>
    );
  }
  if (camera === "priming") {
    return (
      <>
        <Text role="title">Scan a pairing code</Text>
        <Text role="body">
          Allow camera access to scan the QR code shown on the host.
        </Text>
        <PairAction label="Continue" disabled={requesting} onPress={request} />
      </>
    );
  }

  return (
    <>
      <Text role="title">Scan QR</Text>
      <View className="h-64 overflow-hidden rounded-xl bg-card">
        <CameraView
          ref={view}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            if (captured.current || !data.startsWith("SGP1:")) return;
            captured.current = true;
            inspect(data);
          }}
          onMountError={({ message }) => {
            console.warn("[pairing] Could not open camera", message);
            setCamera("unavailable");
          }}
          // CameraView does not consume NativeWind classes.
          style={{ flex: 1 }}
          accessibilityLabel="Pairing QR scanner"
        />
      </View>
    </>
  );
}
