import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const expectRemoteConfiguration =
  process.env.EXPECT_DESIGN_MATE_REMOTE_CONFIGURED === "true";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeProfile(path) {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

function runProbe(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 5_000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

async function browserExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  for (const candidate of candidates) {
    if (await runProbe(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Chrome or Chromium is required for the editor browser smoke test.",
  );
}

async function waitForDebugger(profile, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("The browser exited before its debugger was ready.");
    }
    try {
      const activePort = await readFile(
        join(profile, "DevToolsActivePort"),
        "utf8",
      );
      const port = Number(activePort.split(/\r?\n/, 1)[0]);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("Chrome reported an invalid debugger port.");
      }
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.webSocketDebuggerUrl === "string",
        );
        if (page) {
          return page.webSocketDebuggerUrl;
        }
      }
    } catch {
      // Chrome may still be binding its debugger port.
    }
    await wait(100);
  }
  throw new Error("The browser debugger did not become ready.");
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("The browser debugger socket timed out."));
    }, 10_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("The browser debugger socket failed."));
      },
      { once: true },
    );
  });
}

function createDevtoolsClient(socket) {
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) {
      request.reject(
        new Error(
          typeof message.error.message === "string"
            ? message.error.message
            : "The browser debugger command failed.",
        ),
      );
    } else {
      request.resolve(message.result ?? {});
    }
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("The browser debugger socket closed."));
    }
    pending.clear();
  });

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      sequence += 1;
      const id = sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The browser command ${method} timed out.`));
      }, 10_000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(client, expression) {
  const result = await client("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error("A browser smoke-test expression failed.");
  }
  return result.result?.value;
}

async function waitForEditor(client, expectedWidth) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(
        client,
        `(() => {
          const body = document.body?.innerText ?? "";
          return {
            ready: document.documentElement.dataset.openlogoEditorReadyMs ?? null,
            canvas: Boolean(document.querySelector('canvas[aria-label="OpenLogo canvas"]')),
            designMate: Boolean(document.querySelector("[data-design-mate-trigger]")),
            crashed: body.includes("The editor hit an unexpected error."),
            rendererFailed: body.includes("Vector engine unavailable"),
            width: window.innerWidth,
          };
        })()`,
      );
      if (state?.crashed || state?.rendererFailed) {
        throw new Error("The editor entered a recovery state.");
      }
      if (
        state?.ready &&
        state.canvas &&
        state.designMate &&
        state.width === expectedWidth
      ) {
        return;
      }
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.message === "The editor entered a recovery state."
      ) {
        throw cause;
      }
      // Navigation can briefly invalidate the page execution context.
    }
    await wait(100);
  }
  throw new Error(`The editor did not become ready at ${expectedWidth}px.`);
}

async function verifyDesignMatePanel(client) {
  const opened = await evaluate(
    client,
    `(() => {
      const trigger = document.querySelector("[data-design-mate-trigger]");
      if (!(trigger instanceof HTMLButtonElement)) return false;
      trigger.click();
      return true;
    })()`,
  );
  if (!opened) {
    throw new Error("The Design Mate launcher was unavailable.");
  }

  const deadline = Date.now() + 15_000;
  let verified = false;
  while (Date.now() < deadline) {
    const state = await evaluate(
      client,
      `(() => {
        const panel = document.querySelector("#design-mate-companion-panel");
        const text = panel?.textContent ?? "";
        return {
          loaded: text.includes("Chat with Design Mate"),
          failed: text.includes("Design Mate failed to load"),
          remoteOff: text.includes("Remote AI is off"),
          closeFocused:
            document.activeElement?.getAttribute("aria-label") ===
            "Close Design Mate",
        };
      })()`,
    );
    if (state?.failed) {
      throw new Error("The Design Mate panel entered its recovery state.");
    }
    if (state?.loaded && state.closeFocused) {
      if (expectRemoteConfiguration && !state.remoteOff) {
        throw new Error("The remote AI consent control was not rendered.");
      }
      verified = true;
      break;
    }
    await wait(100);
  }
  if (!verified) {
    throw new Error("The Design Mate panel did not finish loading.");
  }

  await client("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
  });
  await client("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
  });
  const closedDeadline = Date.now() + 5_000;
  while (Date.now() < closedDeadline) {
    const closed = await evaluate(
      client,
      `(() => {
        const trigger = document.querySelector("[data-design-mate-trigger]");
        return trigger?.getAttribute("aria-expanded") === "false" &&
          document.activeElement === trigger;
      })()`,
    );
    if (closed) {
      return;
    }
    await wait(50);
  }
  throw new Error("Escape did not close and restore focus from Design Mate.");
}

async function stopBrowser(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([exited, wait(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, wait(3_000)]);
  }
}

const profile = await mkdtemp(join(tmpdir(), "openlogo-browser-smoke-"));
const server = await preview({
  root: packageRoot,
  logLevel: "error",
  preview: {
    host: "127.0.0.1",
    port: 0,
    strictPort: true,
  },
});
const serverAddress = server.httpServer.address();
if (!serverAddress || typeof serverAddress === "string") {
  await server.close();
  await removeProfile(profile);
  throw new Error("The editor preview did not expose a smoke-test port.");
}
const appPort = serverAddress.port;
const browser = spawn(
  await browserExecutable(),
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1440,1000",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const browserExited = new Promise((resolve) => browser.once("exit", resolve));
let browserOutput = "";
browser.stderr.on("data", (chunk) => {
  browserOutput = `${browserOutput}${String(chunk)}`.slice(-16_384);
});

let socket;
try {
  const debuggerUrl = await waitForDebugger(profile, browser);
  socket = await openSocket(debuggerUrl);
  const client = createDevtoolsClient(socket);
  await client("Page.enable");
  await client("Runtime.enable");
  await client("Emulation.setDeviceMetricsOverride", {
    width: 1_440,
    height: 1_000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client("Page.navigate", {
    url: `http://127.0.0.1:${appPort}/`,
  });
  await waitForEditor(client, 1_440);
  await verifyDesignMatePanel(client);

  await client("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client("Page.reload", { ignoreCache: true });
  await waitForEditor(client, 390);
  process.stdout.write(
    "OpenLogo editor and Design Mate browser smoke checks passed.\n",
  );
} catch (cause) {
  process.stderr.write(browserOutput);
  throw cause;
} finally {
  socket?.close();
  await stopBrowser(browser, browserExited);
  await server.close();
  await removeProfile(profile);
}
