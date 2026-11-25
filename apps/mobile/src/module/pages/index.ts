import type { HostId } from "@core/generated/types";
import type { PhoneRemoteHostStatus } from "@core/phone-connection";
import type { PopoverCard } from "@core/popover/card-order";
import type { ComponentType } from "react";
import { GenericModulePage } from "./generic";

/** The rolling window duration selected in the range control, in milliseconds. */
export type HistoryRangeChoice = number;

export interface ModulePageProps {
  host: HostId;
  module: PopoverCard;
  range: HistoryRangeChoice;
  remote: PhoneRemoteHostStatus | undefined;
}

export const MODULE_PAGES: Record<
  PopoverCard,
  ComponentType<ModulePageProps>
> = {
  cpu: GenericModulePage,
  memory: GenericModulePage,
  gpu: GenericModulePage,
  power: GenericModulePage,
  network: GenericModulePage,
  battery: GenericModulePage,
};
