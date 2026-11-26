/**
 * The History tab's "History" panel: the storage meter, how long to keep
 * history with its projected size on this Mac, the size limit (D-059),
 * per-app Network history (D-089), and the store's low-disk and trim notices
 * under the panel.
 */
import { MISSING } from "@core/format";
import type { Settings } from "@core/generated/types";
import {
  approxSize,
  type RetentionProjection,
  sizeLimitLabel,
} from "@core/history-projection";
import { RETENTION_DAYS, SIZE_LIMITS_MB } from "@core/settings-patch";
import { HistoryNotices } from "~/components/history-notices";
import { SettingsPanel, SettingsRow } from "~/components/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useHistoryHealth } from "~/hooks/use-history-health";
import { useProcessNetwork } from "~/hooks/use-process-interest";
import { useWriteSettings } from "~/hooks/use-write-settings";
import { useRetentionProjection } from "../_hooks/use-history-size";
import { HistoryMeter } from "./history-meter";

/**
 * "History": the storage meter, retention, size limit and Network history,
 * then the store's notices.
 */
export function HistoryPanel({ history }: { history: Settings["history"] }) {
  const write = useWriteSettings();
  const health = useHistoryHealth();
  // Per-app network history needs NetworkStatistics (D-089); hidden without it.
  const perAppNetwork = useProcessNetwork();

  return (
    <SettingsPanel
      id="history"
      title="History"
      after={<HistoryNotices health={health.health} error={health.error} />}
    >
      <HistoryMeter history={history} />
      <KeepHistoryRow history={history} />
      <SizeLimitRow history={history} />
      {perAppNetwork && (
        <SettingsRow
          id="network-history"
          label="Network history"
          sub="Keeps which apps used the network, in 10 s steps. Costs about 0.1% CPU when idle."
        >
          <Switch
            checked={history.network_history !== false}
            aria-label="Network history"
            onCheckedChange={(on) =>
              write({ history: { network_history: on } })
            }
          />
        </SettingsRow>
      )}
    </SettingsPanel>
  );
}

/** What a retention option costs: its size, or the limit that caps it. */
function optionCostText(
  projection: RetentionProjection | null,
  limitText: string
): string {
  if (projection === null) return MISSING;
  if (projection.limitedDays === null)
    return `about ${approxSize(projection.bytes)}`;
  return `${limitText}, about ${projection.limitedDays} days`;
}

/** Keep history: the retention choice, each option with its projected size. */
function KeepHistoryRow({ history }: { history: Settings["history"] }) {
  const write = useWriteSettings();
  const projection = useRetentionProjection(history);
  const limitText = sizeLimitLabel(history.size_limit_mb);
  const current = projection(history.retention_days);

  return (
    <SettingsRow
      id="keep-history"
      label="Keep history"
      htmlFor="settings-retention"
      sub={
        current?.limitedDays != null &&
        `Limited to about ${current.limitedDays} days by the ${limitText} limit`
      }
    >
      <span className="figures text-muted-foreground text-small">
        {current ? `about ${approxSize(current.bytes)}` : MISSING}
      </span>
      <Select
        value={String(history.retention_days)}
        onValueChange={(v) => write({ history: { retention_days: Number(v) } })}
      >
        <SelectTrigger
          id="settings-retention"
          size="sm"
          className="px-2 text-small"
        >
          <SelectValue>{history.retention_days} days</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {RETENTION_DAYS.map((d) => (
            <SelectItem key={d} value={String(d)}>
              {d} days
              <span className="figures text-label text-muted-foreground">
                {optionCostText(projection(d), limitText)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}

/** History size limit: the cap the store prunes to (D-059). */
function SizeLimitRow({ history }: { history: Settings["history"] }) {
  const write = useWriteSettings();
  return (
    <SettingsRow
      id="history-size-limit"
      label="History size limit"
      htmlFor="settings-size-limit"
    >
      <Select
        value={String(history.size_limit_mb)}
        onValueChange={(v) => write({ history: { size_limit_mb: Number(v) } })}
      >
        <SelectTrigger
          id="settings-size-limit"
          size="sm"
          className="px-2 text-small"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SIZE_LIMITS_MB.map((mb) => (
            <SelectItem key={mb} value={String(mb)}>
              {sizeLimitLabel(mb)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
