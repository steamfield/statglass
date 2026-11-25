export function chartLabel(input: {
  subject: string;
  spanMs: number;
  now: string | null;
  brushable?: boolean;
}): string {
  return input.subject;
}

export function shouldRefreshFigures(
  _prev: { bucketMs: number; edgeMs: number } | null,
  _next: { bucketMs: number; edgeMs: number }
): boolean {
  return true;
}
