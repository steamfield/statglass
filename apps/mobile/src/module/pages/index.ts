/** Map module routes to their page components. */
import type { HostId } from "@core/generated/types";
import type { PhoneRemoteHostStatus } from "@core/phone-connection";
import type { PopoverCard } from "@core/popover/card-order";
import type { ComponentType } from "react";
import { BatteryPage } from "./battery";
import { CpuPage } from "./cpu";
import { GpuPage } from "./gpu";
import { MemoryPage } from "./memory";
import { NetworkPage } from "./network";
import { PowerPage } from "./power";

/** Host and connection status supplied by the module route. */
export interface ModulePageProps {
  host: HostId;
  remote: PhoneRemoteHostStatus | undefined;
}

/** The page for each module route. */
export const MODULE_PAGES: Record<
  PopoverCard,
  ComponentType<ModulePageProps>
> = {
  cpu: CpuPage,
  memory: MemoryPage,
  gpu: GpuPage,
  power: PowerPage,
  network: NetworkPage,
  battery: BatteryPage,
};
