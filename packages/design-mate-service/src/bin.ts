import {
  installDesignMateServiceSignalHandlers,
  loadDesignMateServiceConfig,
  startDesignMateService,
  DESIGN_MATE_SERVICE_VERSION,
  type DesignMateServiceLogEntry,
} from "./index";

function writeLog(entry: DesignMateServiceLogEntry): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function writeLifecycleLog(
  level: "info" | "error",
  event: "service-started" | "service-start-failed",
  details: Readonly<Record<string, string | number>> = {},
): void {
  const destination = level === "error" ? process.stderr : process.stdout;
  destination.write(
    `${JSON.stringify({
      schemaVersion: 1,
      service: "openlogo-design-mate",
      level,
      event,
      ...details,
    })}\n`,
  );
}

try {
  const config = loadDesignMateServiceConfig(process.env);
  const server = await startDesignMateService({
    config,
    logger: writeLog,
  });
  installDesignMateServiceSignalHandlers(server);
  writeLifecycleLog("info", "service-started", {
    host: config.host,
    port: config.port,
    version: DESIGN_MATE_SERVICE_VERSION,
  });
} catch {
  writeLifecycleLog("error", "service-start-failed");
  process.exitCode = 1;
}
