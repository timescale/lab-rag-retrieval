// Seeded random sampling — shared by evaluate.ts and ingest.ts
// Uses mulberry32 PRNG for reproducible Fisher-Yates shuffle.

const SEED = 42;

function makeRng(seed: number) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleQuestions<T>(all: T[], n: number): T[] {
  const rand = makeRng(SEED);
  const shuffled = [...all];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, n);
}
