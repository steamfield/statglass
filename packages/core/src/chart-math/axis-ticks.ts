export interface AxisTick {
  value: number;
  frac: number;
  label: string;
}

export function valueTicks(
  _ceiling: number,
  _format: (value: number) => string,
  _opts?: { count?: number }
): AxisTick[] {
  return [];
}

export function timeTicks(
  _fromMs: number,
  _toMs: number,
  _widthPx: number,
  _opts: { clockOffsetMs: number; nowMs: number; captionScale?: number }
): AxisTick[] {
  return [];
}
