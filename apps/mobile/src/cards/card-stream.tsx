import type { StreamAreaData } from "@core/widget-models/stream-area";
import { StreamArea } from "@/widgets/stream-area";

/** CPU and GPU keep a short plot when their details collapse. */
export function CardStream({
  stream,
  compact,
  height,
}: {
  stream: StreamAreaData | null;
  compact: boolean;
  height: number;
}) {
  if (!stream) return null;
  if (!compact) return <StreamArea {...stream} height={height} />;
  const { ceilingLabel: _ceiling, windowLabel: _window, ...plot } = stream;
  return <StreamArea {...plot} variant="spark" height={14} />;
}
