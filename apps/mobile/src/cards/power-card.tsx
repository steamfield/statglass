import { formatWatts, MISSING } from "@core/format";
import { powerCard } from "@core/popover/cards";
import { describeStats } from "@core/widget-models/stat-list";
import { BatteryDetails } from "@/cards/battery-card";
import { ModuleCard } from "@/cards/module-card";
import type { PowerCardProps } from "@/cards/types";
import { UnavailableCardRow } from "@/cards/unavailable-card";
import { Text } from "@/ui/text";
import { StackBar } from "@/widgets/stack-bar";
import { StatList } from "@/widgets/stat-list";

function powerFigures(
  headline: string,
  unit: string | undefined,
  charge: string | undefined
) {
  if (!charge || charge === MISSING) return { headline, unit };
  if (headline === MISSING) {
    return { headline: charge, spokenHeadline: `Battery ${charge}` };
  }
  const power = unit ? `${headline} ${unit}` : headline;
  return {
    headline: `${power} · ${charge}`,
    spokenHeadline: `${power}, Battery ${charge}`,
  };
}

function reportsNothing(
  headline: string,
  items: readonly unknown[],
  battery: unknown
) {
  return headline === MISSING && items.length === 0 && !battery;
}

function hasBatteryReading(battery: PowerCardProps["battery"]) {
  return (
    battery !== null &&
    [
      battery.charge,
      battery.timeRemainingMin,
      battery.health,
      battery.cycles,
    ].some((value) => value !== null)
  );
}

/**
 * The desktop keeps the full rail legend. The phone only lists readings the
 * host reported, including a measured zero, except while the layout loads,
 * when a Mac's rails hold their place as dashes over an empty stack.
 */
function shownRails(
  card: Pick<ReturnType<typeof powerCard>, "items" | "segments">,
  awaiting: boolean,
  { components }: Pick<PowerCardProps["power"], "components">
) {
  if (awaiting && components) return { items: card.items, completeStack: true };
  return {
    items: card.items.filter(({ value }) => value !== MISSING),
    // Without a known remainder the stack would scale reported rails to 100%.
    completeStack: card.segments.some(
      ({ key, fraction }) => key === "rest" && fraction !== null
    ),
  };
}

export function PowerCard({
  power,
  source,
  battery,
  awaiting = false,
  ...chrome
}: PowerCardProps) {
  const card = powerCard(power, {
    // While the layout loads, the battery rows hold their place as dashes.
    battery: awaiting || hasBatteryReading(battery) ? battery : null,
    powerSource: source,
  });
  const { title, note } = card;
  const packageOnly = card.headline === MISSING && power.package !== null;
  const headline = packageOnly ? formatWatts(power.package) : card.headline;
  const unit = packageOnly ? "package" : card.headlineUnit;
  const { items, completeStack } = shownRails(card, awaiting, power);
  // A host that answered with no power reading at all gets one quiet row.
  if (!awaiting && reportsNothing(headline, items, card.battery)) {
    return (
      <UnavailableCardRow
        title={title}
        accent="power"
        reason="No power readings"
        onOpen={chrome.onOpen}
        accessibilityActions={chrome.accessibilityActions}
        onAccessibilityAction={chrome.onAccessibilityAction}
      />
    );
  }

  const charge = chrome.compact ? card.battery?.headline : undefined;
  const content = {
    title,
    headline,
    items,
    segments: card.segments,
    bars: card.bars,
    get spoken() {
      const battery = card.battery;
      const details = battery
        ? [
            ...items,
            { label: battery.title, value: battery.headline },
            ...battery.items,
          ]
        : items;
      return describeStats(details, note ?? undefined);
    },
  };
  return (
    <ModuleCard
      {...chrome}
      card="power"
      content={content}
      accent="power"
      {...powerFigures(headline, unit, charge)}
    >
      {!chrome.compact && (
        <>
          {completeStack && <StackBar segments={[...card.segments]} />}
          {items.length > 0 && <StatList layout="grid" items={items} />}
          {card.battery && <BatteryDetails card={card.battery} showCharge />}
          {note && <Text variant="caption">{note}</Text>}
        </>
      )}
    </ModuleCard>
  );
}
