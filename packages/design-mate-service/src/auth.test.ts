import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createBearerTokenRequestAuth,
  isValidRequestAuthIdentity,
} from "./auth";

function request(authorization?: string): IncomingMessage {
  return {
    headers:
      authorization === undefined ? {} : { authorization },
  } as IncomingMessage;
}

describe("Design Mate service auth", () => {
  it("accepts only an exact bearer credential", async () => {
    const auth = createBearerTokenRequestAuth("service-secret");
    const signal = new AbortController().signal;

    expect(
      await Promise.resolve(
        auth.authenticate({
          request: request("Bearer service-secret"),
          remoteAddress: "127.0.0.1",
          signal,
        }),
      ),
    ).toEqual({ subject: "service-token" });
    for (const authorization of [
      undefined,
      "Basic service-secret",
      "Bearer wrong",
      "Bearer service-secret extra",
      "Bearer service-secret,other",
    ]) {
      expect(
        await Promise.resolve(
          auth.authenticate({
            request: request(authorization),
            remoteAddress: "127.0.0.1",
            signal,
          }),
        ),
      ).toBeNull();
    }
  });

  it("validates exact, bounded auth identities without throwing", () => {
    expect(isValidRequestAuthIdentity({ subject: "user-1" })).toBe(true);
    expect(
      isValidRequestAuthIdentity({ subject: "user-1", role: "admin" }),
    ).toBe(false);
    expect(isValidRequestAuthIdentity({ subject: " " })).toBe(false);
    expect(
      isValidRequestAuthIdentity({
        subject: "x".repeat(257),
      }),
    ).toBe(false);
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile");
        },
      },
    );
    expect(() => isValidRequestAuthIdentity(hostile)).not.toThrow();
    expect(isValidRequestAuthIdentity(hostile)).toBe(false);
  });

  it("rejects unsafe configured credentials", () => {
    for (const token of ["", " spaced", "has space", "line\nbreak"]) {
      expect(() => createBearerTokenRequestAuth(token)).toThrow(TypeError);
    }
  });

  it("honors cancellation before evaluating a bearer credential", () => {
    const controller = new AbortController();
    controller.abort("request-timeout");
    const auth = createBearerTokenRequestAuth("service-secret");
    expect(() =>
      auth.authenticate({
        request: request("Bearer service-secret"),
        remoteAddress: "127.0.0.1",
        signal: controller.signal,
      }),
    ).toThrow();
  });
});
