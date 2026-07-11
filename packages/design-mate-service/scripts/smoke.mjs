import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a smoke-test port.");
  }
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("The service exited before becoming healthy.");
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
    } catch {
      // The listener may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The service did not become healthy.");
}

const port = await availablePort();
const child = spawn(process.execPath, ["dist/server.js"], {
  cwd: packageRoot,
  env: {
    ...process.env,
    DESIGN_MATE_SERVICE_HOST: "127.0.0.1",
    DESIGN_MATE_SERVICE_PORT: String(port),
    DESIGN_MATE_ALLOW_ANONYMOUS_LOOPBACK: "true",
    DESIGN_MATE_PROVIDER_API_KEY: "smoke-provider-key",
    DESIGN_MATE_PROVIDER_MODEL: "smoke-model",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
const retainOutput = (chunk) => {
  output = `${output}${String(chunk)}`.slice(-16_384);
};
child.stdout.on("data", retainOutput);
child.stderr.on("data", retainOutput);

try {
  const response = await waitForHealth(
    `http://127.0.0.1:${port}/health`,
    child,
  );
  const body = await response.json();
  if (body.status !== "ok" || typeof body.version !== "string") {
    throw new Error("The health response was invalid.");
  }
} catch (cause) {
  process.stderr.write(output);
  throw cause;
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("The service did not stop cleanly.")),
          5_000,
        ),
      ),
    ]);
  }
}
