/** Coerce any finite numeric seed to the stable uint32 domain. */
export function normalizeSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
}

export type Prng = {
  next(): number;
  float(min: number, max: number): number;
  int(min: number, max: number): number;
  chance(probability?: number): boolean;
  pick<T>(values: readonly T[]): T;
};

/** Small deterministic generator with mulberry32's 32-bit transition. */
export function createPrng(seed: number): Prng {
  let state = normalizeSeed(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    float: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    chance: (probability = 0.5) => next() < probability,
    pick: <T>(values: readonly T[]): T => {
      if (values.length === 0) {
        throw new RangeError("Cannot pick from an empty ingredient list.");
      }
      return values[Math.floor(next() * values.length)]!;
    },
  };
}
