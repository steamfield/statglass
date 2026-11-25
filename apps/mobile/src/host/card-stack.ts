import type { PowerSource } from "@core/generated/types";
import type { HostLive } from "@core/live-state";
import type { ModuleState, UiModule } from "@core/module-state";
import { moduleState } from "@core/module-state";
import { type PopoverCard, popoverSlots } from "@core/popover/card-order";
import type {
  BatteryCardProps,
  CardChrome,
  CpuCardProps,
  GpuCardProps,
  MemoryCardProps,
  NetworkCardProps,
  PowerCardProps,
  UnavailableCardProps,
} from "@/cards/types";
import type {
  PhoneSettings,
  PhoneSettingsActions,
} from "@/data/phone-settings";

/** Module cards in the default popover order, including the standalone battery card. */
export const CARD_MODULES = [
  "cpu",
  "memory",
  "gpu",
  "power",
  "network",
  "battery",
] as const satisfies readonly PopoverCard[];

type Settings = Pick<PhoneSettings, "compact" | "cardOrder">;

type CardData = {
  cpu: Pick<CpuCardProps, "cpu" | "stream">;
  memory: Pick<MemoryCardProps, "memory"> & { totalBytes: number | null };
  gpu: Pick<GpuCardProps, "gpu" | "stream">;
  power: Pick<PowerCardProps, "power" | "source">;
  network: Pick<NetworkCardProps, "network" | "bars">;
  battery: Pick<BatteryCardProps, "battery"> & { source: PowerSource | null };
};

type CardActions = Pick<
  CardChrome,
  "onOpen" | "onLongPress" | "onToggleDensity"
>;

export function toggleCardDensity(
  set: PhoneSettingsActions["set"],
  card: PopoverCard
) {
  set(({ compact }) => ({ compact: { ...compact, [card]: !compact[card] } }));
}

/** Bind each card's callbacks so they can stay stable across frames. */
export function cardActions(
  open: (card: PopoverCard) => void,
  openMenu: (card: PopoverCard) => void,
  toggleDensity: (card: PopoverCard) => void
): Record<PopoverCard, CardActions> {
  return Object.fromEntries(
    CARD_MODULES.map((card) => [
      card,
      {
        onOpen: () => open(card),
        onLongPress: () => openMenu(card),
        onToggleDensity: () => toggleDensity(card),
      },
    ])
  ) as Record<PopoverCard, CardActions>;
}

type CardProps = Omit<CardData, "power"> & {
  power: CardData["power"] & { battery: BatteryCardProps["battery"] | null };
};

export type CardStackItem =
  | { kind: "unavailable"; props: UnavailableCardProps }
  | {
      [Card in PopoverCard]: {
        kind: Card;
        props: CardProps[Card] & CardChrome;
      };
    }[PopoverCard];

/** Classify the host's modules from capabilities using the shared popover rules. */
export function cardModuleStates(
  caps: HostLive["capabilities"]
): Record<UiModule, ModuleState> {
  return {
    cpu: moduleState(caps, null, "cpu"),
    memory: moduleState(caps, null, "memory"),
    gpu: moduleState(caps, null, "gpu"),
    power: moduleState(caps, null, "power"),
    network: moduleState(caps, null, "network"),
    battery: moduleState(caps, null, "battery"),
    disk: moduleState(caps, null, "disk"),
  };
}

/** One pure projection of the available slots into the cards' public props. */
export function buildCardStack(
  states: Record<UiModule, ModuleState>,
  { compact, cardOrder }: Settings,
  data: CardData,
  actions: Record<PopoverCard, CardActions>,
  stale: boolean
): CardStackItem[] {
  const rank = new Map<UiModule, number>(
    cardOrder?.map((card, i) => [card, i])
  );
  const slots = popoverSlots(states);
  if (rank.size) {
    slots.sort(
      (a, b) =>
        (rank.get(a.kind === "card" ? a.card : a.module) ?? rank.size) -
        (rank.get(b.kind === "card" ? b.card : b.module) ?? rank.size)
    );
  }
  return slots.map((slot) => {
    if (slot.kind === "unavailable") {
      return {
        kind: "unavailable",
        props: { module: slot.module, state: slot.state },
      };
    }
    const card = slot.card;
    const chrome = {
      compact: compact[card],
      stale,
      ...actions[card],
    };
    switch (card) {
      case "cpu":
        return { kind: card, props: { ...data.cpu, ...chrome } };
      case "memory":
        return { kind: card, props: { ...data.memory, ...chrome } };
      case "gpu":
        return { kind: card, props: { ...data.gpu, ...chrome } };
      case "power":
        return {
          kind: card,
          props: {
            ...data.power,
            battery: states.battery === "on" ? data.battery.battery : null,
            ...chrome,
          },
        };
      case "network":
        return { kind: card, props: { ...data.network, ...chrome } };
      default:
        return { kind: card, props: { ...data.battery, ...chrome } };
    }
  });
}

/** Move within the visible cards while retaining preferences for other hosts. */
export function moveCard(
  order: PopoverCard[] | null,
  card: PopoverCard,
  neighbor: PopoverCard
): PopoverCard[] {
  return [...new Set([...(order ?? []), ...CARD_MODULES])].map((entry) =>
    entry === card ? neighbor : entry === neighbor ? card : entry
  );
}
