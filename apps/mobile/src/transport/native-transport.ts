/**
 * The phone's real transport: the `PhoneTransport` seam over the native
 * core, so every screen reads a paired host the way it reads the demo.
 */
import type {
  BuildInfo,
  DataPolicy,
  MobileConfig,
  MobileHost,
} from "@core/generated/types";
import type { CommandResult } from "@core/transport";
import type { StatglassNativeModule } from "@native/statglass-native";
import type { PhoneTransport } from "@/data/seam";

/** The seam plus what only the native core does. */
export interface NativeTransport extends PhoneTransport {
  setHosts(hosts: MobileHost[]): Promise<CommandResult<null>>;
  setDataPolicy(policy: DataPolicy): Promise<CommandResult<null>>;
  /** The `authorized_keys` line for this phone's key. */
  authorizedKeyLine(comment: string): Promise<CommandResult<string>>;
  buildInfo(): Promise<CommandResult<BuildInfo>>;
  /** Ends every stream and listener; the core keeps running. */
  dispose(): void;
}

/**
 * Starts the core with `config` and returns the transport over it.
 * @throws the module's typed error when Swift cannot prepare the data
 *   directory or the key
 */
export async function startNativeTransport(
  native: StatglassNativeModule,
  config: MobileConfig
): Promise<CommandResult<NativeTransport>> {
  void native;
  void config;
  throw new Error("startNativeTransport: not implemented (phase 4 lane c)");
}

/** The transport over a core that has already started. */
export function createNativeTransport(
  native: StatglassNativeModule
): NativeTransport {
  void native;
  throw new Error("createNativeTransport: not implemented (phase 4 lane c)");
}

/** Whether `transport` is the native one (it carries the native-only calls). */
export function isNativeTransport(
  transport: PhoneTransport | null
): transport is NativeTransport {
  return transport !== null && "setDataPolicy" in transport;
}
