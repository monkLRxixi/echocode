#!/usr/bin/env node
// Launcher: prefer the compiled build, fall back to tsx so `node bin/echocode.js`
// works straight from a checkout with no build step.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const src = fileURLToPath(new URL("../src/main.ts", import.meta.url));

async function run() {
  if (existsSync(dist)) {
    const { main } = await import(dist);
    await main(process.argv.slice(2));
    return;
  }
  const r = spawnSync(process.execPath, ["--import", "tsx", src, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 0);
}

run().catch((err) => {
  const msg = err?.message ?? String(err);
  process.stderr.write(`\x1b[1;38;5;203mechocode: ${msg}\x1b[0m\n`);
  process.exit(1);
});
