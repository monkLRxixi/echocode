#!/usr/bin/env node
// Launcher: run the compiled build (dist/), fall back to tsx for a plain
// checkout so `node bin/echocode.js` works without building first.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Note: `import()` needs a file:// URL, not a native path — on Windows a bare
// `O:\...\dist\cli.js` throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
const distUrl = new URL("../dist/cli.js", import.meta.url);
const dist = fileURLToPath(distUrl);
const src = fileURLToPath(new URL("../src/main.ts", import.meta.url));

function hasTsx() {
  try {
    createRequire(import.meta.url).resolve("tsx");
    return true;
  } catch {
    return false;
  }
}

async function run() {
  if (existsSync(dist)) {
    const { main } = await import(distUrl.href);
    await main(process.argv.slice(2));
    return;
  }

  if (!hasTsx()) {
    process.stderr.write(
      "echocode: build output not found (dist/) and tsx is not installed.\n" +
        "  from a checkout:  npm install && npm run build\n" +
        "  from npm:         reinstall the package (the published tarball ships dist/)\n",
    );
    process.exit(1);
  }

  const r = spawnSync(process.execPath, ["--import", "tsx", src, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 0);
}

const OPS = /^cannot reach |^HTTP \d+:|^no API key|not found/;

run().catch((err) => {
  const msg = OPS.test(err?.message ?? "") || err?.name === "ApiError" ? String(err.message) : err?.stack ?? String(err);
  process.stderr.write(`\x1b[1;38;5;203mechocode: ${msg}\x1b[0m\n`);
  process.exit(1);
});
