import {
  installDesignMateServiceSignalHandlers,
  loadDesignMateServiceConfig,
  startDesignMateService,
  type DesignMateServiceLogEntry,
} from "./index";

function writeLog(entry: DesignMateServiceLogEntry): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

try {
  const config = loadDesignMateServiceConfig(process.env);
  const server = await startDesignMateService({
    config,
    logger: writeLog,
  });
  installDesignMateServiceSignalHandlers(server);
  process.stdout.write("Design Mate service listening.\n");
} catch {
  process.stderr.write("Design Mate service failed to start.\n");
  process.exitCode = 1;
}
