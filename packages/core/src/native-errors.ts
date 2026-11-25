export interface NativeError {
  source: "native";
  kind: "keychain" | "secureEnclave" | "camera" | "localNetwork";
  osStatus: number | null;
  message: string;
}

export function isNativeError(error: unknown): error is NativeError {
  return (
    typeof error === "object" &&
    error !== null &&
    "source" in error &&
    error.source === "native" &&
    "kind" in error &&
    (error.kind === "keychain" ||
      error.kind === "secureEnclave" ||
      error.kind === "camera" ||
      error.kind === "localNetwork") &&
    "osStatus" in error &&
    (error.osStatus === null ||
      (typeof error.osStatus === "number" &&
        Number.isInteger(error.osStatus))) &&
    "message" in error &&
    typeof error.message === "string"
  );
}

// Security.framework OSStatus values carried by the native error.
const ERR_SEC_ITEM_NOT_FOUND = -25300;
const ERR_SEC_INTERACTION_NOT_ALLOWED = -25308;

export function nativeErrorText(error: NativeError): {
  title: string;
  recovery: string;
} {
  switch (error.kind) {
    case "keychain":
    case "secureEnclave":
      if (error.osStatus === ERR_SEC_INTERACTION_NOT_ALLOWED) {
        return {
          title: "Unlock this iPhone to connect",
          recovery: "Unlock with your passcode, then try again.",
        };
      }
      if (error.osStatus === ERR_SEC_ITEM_NOT_FOUND) {
        return {
          title: "Phone key is missing",
          recovery: "Pair this iPhone with the host again.",
        };
      }
      return {
        title:
          error.kind === "keychain"
            ? "Phone key is unavailable"
            : "Secure Enclave key is unavailable",
        recovery: "Try again. If the problem persists, pair this iPhone again.",
      };
    case "camera":
      return {
        title: "Camera is unavailable",
        recovery:
          "Allow camera access for StatGlass in Settings to scan a pairing code.",
      };
    case "localNetwork":
      return {
        title: "Local network access is unavailable",
        recovery: "Allow Local Network access for StatGlass in Settings.",
      };
  }
}
