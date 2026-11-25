import type { CommandError } from "@core/generated/types";
import type { NativeError } from "@core/native-errors";
import type { JSX, ReactNode } from "react";
import type { NativeTransport } from "./native-transport";

export function CoreProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return <>{children}</>;
}

export function useNativeCore(): {
  core: NativeTransport | null;
  error: NativeError | CommandError | null;
  retry(): void;
} {
  return { core: null, error: null, retry() {} };
}
