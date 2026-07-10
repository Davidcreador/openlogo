export type DesignMateServiceClock = () => number;

export type RateLimitDecision =
  | {
      readonly allowed: true;
    }
  | {
      readonly allowed: false;
      readonly retryAfterSeconds: number;
    };

type WindowEntry = {
  readonly window: number;
  count: number;
};

const WINDOW_MS = 60_000;
const MAX_SUBJECTS = 10_000;

export function createFixedWindowRateLimiter(
  requestsPerMinute: number,
  clock: DesignMateServiceClock,
): {
  readonly take: (subject: string) => RateLimitDecision;
} {
  const entries = new Map<string, WindowEntry>();
  let lastPrunedWindow = -1;

  return {
    take: (subject) => {
      const rawNow = clock();
      const now =
        Number.isFinite(rawNow) && rawNow >= 0
          ? Math.floor(rawNow)
          : Date.now();
      const window = Math.floor(now / WINDOW_MS);
      if (window !== lastPrunedWindow) {
        lastPrunedWindow = window;
        for (const [key, entry] of entries) {
          if (entry.window !== window) {
            entries.delete(key);
          }
        }
      }

      let entry = entries.get(subject);
      if (!entry || entry.window !== window) {
        if (entries.size >= MAX_SUBJECTS) {
          return Object.freeze({
            allowed: false,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1_000),
            ),
          });
        }
        entry = { window, count: 0 };
        entries.set(subject, entry);
      }
      if (entry.count >= requestsPerMinute) {
        return Object.freeze({
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1_000),
          ),
        });
      }
      entry.count += 1;
      return Object.freeze({ allowed: true });
    },
  };
}
