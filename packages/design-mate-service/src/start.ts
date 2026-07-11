import type { Server } from "node:http";
import {
  createDesignMateService,
  type CreateDesignMateServiceOptions,
} from "./service";

export async function startDesignMateService(
  options: CreateDesignMateServiceOptions,
): Promise<Server> {
  const server = createDesignMateService(options);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (): void => {
        server.removeListener("listening", onListening);
        reject(new Error("The Design Mate service could not listen."));
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({
        host: options.config.host,
        port: options.config.port,
      });
    });
    return server;
  } catch (cause) {
    try {
      server.close();
    } catch {
      // The server may not have started listening.
    }
    throw cause;
  }
}

export function installDesignMateServiceSignalHandlers(
  server: Server,
  shutdownTimeoutMs = 30_000,
): () => void {
  if (
    !Number.isSafeInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 100 ||
    shutdownTimeoutMs > 120_000
  ) {
    throw new TypeError("The shutdown timeout is invalid.");
  }
  let closing = false;
  let forceTimer: NodeJS.Timeout | undefined;
  const remove = (): void => {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    server.removeListener("close", remove);
    if (forceTimer) {
      clearTimeout(forceTimer);
      forceTimer = undefined;
    }
  };
  const close = (): void => {
    if (closing) {
      server.closeAllConnections();
      return;
    }
    closing = true;
    server.closeIdleConnections();
    server.close(() => {
      remove();
    });
    forceTimer = setTimeout(() => {
      server.closeAllConnections();
    }, shutdownTimeoutMs);
    forceTimer.unref();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  server.once("close", remove);
  return remove;
}
