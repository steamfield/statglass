import { ratio } from "@core/chart-math";
import { formatPercent } from "@core/format";
import { View } from "react-native";
import { ModuleCard } from "@/cards/module-card";
import type { CpuCardProps } from "@/cards/types";
import { InlineBar } from "@/widgets/inline-bar";
import { StreamArea } from "@/widgets/stream-area";

export function CpuCard({ cpu, stream, ...chrome }: CpuCardProps) {
  const user = formatPercent(cpu.user, { decimals: 1 });
  const system = formatPercent(cpu.system, { decimals: 1 });
  const details = `User ${user}, System ${system}`;
  return (
    <ModuleCard
      {...chrome}
      title="CPU"
      accent="cpu"
      headline={formatPercent(cpu.total)}
      spokenDetails={
        stream?.ariaLabel ? `${details}, ${stream.ariaLabel}` : details
      }
    >
      {stream && <StreamArea {...stream} />}
      <View className="gap-1">
        <InlineBar
          label="User"
          value={user}
          fraction={ratio(cpu.user, 100)}
          layout="row"
        />
        <InlineBar
          label="System"
          value={system}
          fraction={ratio(cpu.system, 100)}
          rampStep={2}
          layout="row"
        />
      </View>
    </ModuleCard>
  );
}
