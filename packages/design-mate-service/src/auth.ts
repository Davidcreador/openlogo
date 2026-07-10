import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  isLoopbackHost,
  isLoopbackRemoteAddress,
  type DesignMateServiceConfig,
} from "./config";

export type RequestAuthIdentity = {
  readonly subject: string;
};

export type RequestAuthContext = {
  readonly request: IncomingMessage;
  readonly remoteAddress?: string;
  readonly signal: AbortSignal;
};

export interface RequestAuth {
  authenticate(
    context: RequestAuthContext,
  ):
    | RequestAuthIdentity
    | null
    | Promise<RequestAuthIdentity | null>;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function bearerCredential(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return "";
  }
  const match = /^Bearer ([^\s,]+)$/i.exec(authorization);
  return match?.[1] ?? "";
}

export function isValidRequestAuthIdentity(
  value: unknown,
): value is RequestAuthIdentity {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    const subject = Reflect.get(value, "subject");
    return (
      keys.length === 1 &&
      keys[0] === "subject" &&
      typeof subject === "string" &&
      subject.trim().length > 0 &&
      subject.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(subject)
    );
  } catch {
    return false;
  }
}

export function createBearerTokenRequestAuth(token: string): RequestAuth {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4_096 ||
    token.trim() !== token ||
    /\s|[\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new TypeError("The service token is invalid.");
  }
  const expected = digest(token);
  return {
    authenticate: ({ request }) => {
      const candidate = digest(bearerCredential(request));
      return timingSafeEqual(expected, candidate)
        ? Object.freeze({ subject: "service-token" })
        : null;
    },
  };
}

export function createDefaultRequestAuth(
  config: DesignMateServiceConfig,
): RequestAuth {
  if (config.serviceToken !== undefined) {
    return createBearerTokenRequestAuth(config.serviceToken);
  }
  if (!config.allowAnonymousLoopback || !isLoopbackHost(config.host)) {
    throw new TypeError(
      "Default request auth requires a service token or anonymous loopback opt-in.",
    );
  }
  return {
    authenticate: ({ remoteAddress }) =>
      isLoopbackRemoteAddress(remoteAddress)
        ? Object.freeze({
            subject: `loopback:${remoteAddress ?? "unknown"}`,
          })
        : null,
  };
}
