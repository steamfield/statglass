/**
 * The app lock: when on, foregrounding asks for Face ID or the passcode and
 * backgrounding covers the app with a blur.
 * Scaffold stub: passes its children through until its lane builds it.
 */
import type { ReactNode } from "react";

/** Wraps the root stack below the providers. */
export function AppLockGate({ children }: { children: ReactNode }) {
  return children;
}
