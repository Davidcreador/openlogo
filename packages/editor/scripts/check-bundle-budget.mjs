import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const distUrl = new URL("../dist/", import.meta.url);
const html = await readFile(new URL("index.html", distUrl), "utf8");
const assetNames = [
  ...html.matchAll(/(?:src|href)="(?:\.\/|\/)?assets\/([^"]+\.js)"/g),
].map((match) => match[1]);
const initialJs = [...new Set(assetNames)];
const entryMatch = html.match(
  /<script[^>]+src="(?:\.\/|\/)?assets\/([^"]+\.js)"/,
);

if (!entryMatch || initialJs.length === 0) {
  throw new Error("Could not identify the production entry chunks in dist/index.html.");
}

async function fileBytes(name) {
  return (await stat(new URL(`assets/${name}`, distUrl))).size;
}

const entryName = entryMatch[1];
const entryBytes = await fileBytes(entryName);
const initialSizes = await Promise.all(initialJs.map(fileBytes));
const initialBytes = initialSizes.reduce((total, size) => total + size, 0);
const wasmName = (await readdir(new URL("assets/", distUrl))).find((name) =>
  name.endsWith(".wasm"),
);

if (!wasmName) {
  throw new Error("CanvasKit WASM is missing from the production build.");
}

const wasmBytes = await fileBytes(wasmName);
const budgets = {
  entry: 400 * 1024,
  initialJs: 850 * 1024,
  wasm: 7.5 * 1024 * 1024,
};

const failures = [];
if (entryBytes > budgets.entry) {
  failures.push(
    `entry ${entryName} is ${(entryBytes / 1024).toFixed(1)} KiB (budget ${(budgets.entry / 1024).toFixed(0)} KiB)`,
  );
}
if (initialBytes > budgets.initialJs) {
  failures.push(
    `initial JavaScript is ${(initialBytes / 1024).toFixed(1)} KiB (budget ${(budgets.initialJs / 1024).toFixed(0)} KiB)`,
  );
}
if (wasmBytes > budgets.wasm) {
  failures.push(
    `CanvasKit WASM is ${(wasmBytes / 1024 / 1024).toFixed(2)} MiB (budget ${(budgets.wasm / 1024 / 1024).toFixed(1)} MiB)`,
  );
}

console.log(
  `Bundle budgets: entry ${(entryBytes / 1024).toFixed(1)} KiB; initial JS ${(initialBytes / 1024).toFixed(1)} KiB across ${initialJs.length} chunks; WASM ${(wasmBytes / 1024 / 1024).toFixed(2)} MiB.`,
);

if (failures.length > 0) {
  console.error(`Bundle budget exceeded:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
}
