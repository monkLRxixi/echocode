#!/usr/bin/env node
// Entry point used by the tsx fallback (no build) and by `npm run dev`.
import { main } from "./cli.js";

main(process.argv.slice(2)).catch((err: any) => {
  const msg = err?.stack ?? err?.message ?? String(err);
  process.stderr.write(`\x1b[1;38;5;203mechocode: ${msg}\x1b[0m\n`);
  process.exit(1);
});
