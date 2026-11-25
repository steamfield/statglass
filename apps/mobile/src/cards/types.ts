/**
 * Props of the phone's popover cards. Each card is presentational: it takes
 * a core live selection (and a prepared stream where it draws one) plus the
 * chrome every card shares, and renders it.
 */
import type { PowerSource } from "@core/generated/types";
import type {
  BatterySelection,
  CpuSelection,
  GpuSelection,
  MemorySelection,
  NetworkSelection,
  PowerSelection,
} from "@core/live-selectors";
import type { ModuleState, UiModule } from "@core/module-state";
import type { PopoverCard } from "@core/popover/card-order";
import type { CardContent } from "@core/popover/cards";
import type { MirrorBarsData } from "@core/widget-models/mirror-bars";
import type { StreamAreaData } from "@core/widget-models/stream-area";
import type { ViewProps } from "react-native";

export interface ModuleCardProps
  extends Pick<ViewProps, "accessibilityActions" | "onAccessibilityAction"> {
  card: PopoverCard;
  content: CardContent;
  compact: boolean;
  onToggleDensity(): void;
  onOpen(): void;
  stale: boolean;
}

/** Props shared by the current card renderers. */
export interface CardChrome
  extends Pick<
    ModuleCardProps,
    | "compact"
    | "onToggleDensity"
    | "onOpen"
    | "stale"
    | "accessibilityActions"
    | "onAccessibilityAction"
  > {
  /** Accepted from the host stack scaffold until it owns the whole gesture. */
  onLongPress?(): void;
}

export interface CpuCardProps extends CardChrome {
  cpu: CpuSelection;
  stream: StreamAreaData | null;
}

export interface MemoryCardProps extends CardChrome {
  memory: MemorySelection;
  /** Installed capacity from the host record. */
  totalBytes: number | null;
}

export interface GpuCardProps extends CardChrome {
  gpu: GpuSelection;
  stream: StreamAreaData | null;
}

export interface PowerCardProps extends CardChrome {
  power: PowerSelection;
  source: PowerSource | null;
  /** Battery readings when Power and Battery share the card. */
  battery: BatterySelection | null;
}

export interface NetworkCardProps extends CardChrome {
  network: NetworkSelection;
  bars: MirrorBarsData | null;
}

export interface BatteryCardProps extends CardChrome {
  battery: BatterySelection;
  source: PowerSource | null;
}

/** A module the host cannot run, in place of its card. */
export interface UnavailableCardProps {
  module: UiModule;
  state: ModuleState;
}
