import { formatRate } from "@core/format";
import { ModuleCard } from "@/cards/module-card";
import type { NetworkCardProps } from "@/cards/types";
import { Text } from "@/ui/text";
import { MirrorBars } from "@/widgets/mirror-bars";
import { StatList } from "@/widgets/stat-list";

export function NetworkCard({ network, bars, ...chrome }: NetworkCardProps) {
  const upload = formatRate(network.tx);
  const download = formatRate(network.rx);
  // Keep each rate together when Dynamic Type wraps the headline.
  const headline = `↑\u00a0${upload.replace(" ", "\u00a0")} · ↓\u00a0${download.replace(" ", "\u00a0")}`;
  return (
    <ModuleCard
      {...chrome}
      title="Network"
      accent="net"
      headline={headline}
      spokenHeadline={`Upload ${upload}, Download ${download}`}
      spokenDetails={
        bars ? `All interfaces, ${bars.ariaLabel}` : "All interfaces"
      }
      headlineContent={
        chrome.compact ? null : (
          <StatList
            layout="grid"
            items={[
              { label: "↑ Upload", value: upload.replace(" ", "\u00a0") },
              { label: "↓ Download", value: download.replace(" ", "\u00a0") },
            ]}
          />
        )
      }
    >
      <Text role="caption">All interfaces</Text>
      {bars && <MirrorBars {...bars} />}
    </ModuleCard>
  );
}
