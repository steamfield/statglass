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
import type { MirrorBarsData } from "@core/widget-models/mirror-bars";
import type { StreamAreaData } from "@core/widget-models/stream-area";

/** What every card's chrome needs: its density and its two gestures. */
export interface CardChrome {
  /** Header and headline only. */
  compact: boolean;
  /** Opens the module's page. */
  onOpen(): void;
  /** Opens the card menu (density, move up or down). */
  onLongPress(): void;
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
