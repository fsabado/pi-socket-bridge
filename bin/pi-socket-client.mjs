#!/usr/bin/env -S npx tsx
// pi-socket-client — runs src/cli.ts directly via tsx (no build step)
// Falls back to: node --import tsx/esm if npx tsx is unavailable
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "../src/cli.ts");

// Re-exec via tsx if we were invoked without it (safety net)
const result = spawnSync("tsx", [cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
