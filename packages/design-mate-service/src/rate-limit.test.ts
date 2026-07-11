import { describe, expect, it } from "vitest";
import { createFixedWindowRateLimiter } from "./rate-limit";

describe("Design Mate fixed-window rate limiter", () => {
  it("limits each subject independently and resets on the next window", () => {
    let now = 1_000;
    const limiter = createFixedWindowRateLimiter(2, () => now);

    expect(limiter.take("user-a")).toEqual({ allowed: true });
    expect(limiter.take("user-a")).toEqual({ allowed: true });
    expect(limiter.take("user-b")).toEqual({ allowed: true });
    expect(limiter.take("user-a")).toEqual({
      allowed: false,
      retryAfterSeconds: 59,
    });

    now = 60_000;
    expect(limiter.take("user-a")).toEqual({ allowed: true });
  });

  it("fails closed when the bounded subject table is full", () => {
    const limiter = createFixedWindowRateLimiter(1, () => 0);
    for (let index = 0; index < 10_000; index += 1) {
      expect(limiter.take(`subject-${index}`).allowed).toBe(true);
    }
    expect(limiter.take("one-too-many")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });

  it("uses a safe clock fallback for invalid values", () => {
    const limiter = createFixedWindowRateLimiter(1, () => Number.NaN);
    expect(limiter.take("user").allowed).toBe(true);
    expect(limiter.take("user").allowed).toBe(false);
  });
});
