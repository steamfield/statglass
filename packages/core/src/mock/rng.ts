/**
 * Seeded randomness for sample data: a Lehmer RNG and a string-to-seed hash,
 * so the mock transport's fixtures are the same every run.
 */
export function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** A stable `rng` seed for `s`: its 32-bit FNV-1a, mapped to 1 to 2^31 - 2. */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return ((h >>> 0) % 2147483646) + 1;
}
