export interface NativeError {
  source: "native";
  kind: "keychain" | "secureEnclave" | "camera" | "localNetwork";
  osStatus: number | null;
  message: string;
}

export function isNativeError(_error: unknown): _error is NativeError {
  return false;
}

export function nativeErrorText(_error: NativeError): {
  title: string;
  recovery: string;
} {
  return { title: "", recovery: "" };
}
