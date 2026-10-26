#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const candidates = [
  process.env.OTEL_POCKET_BIN,
  join(__dirname, "otel-pocket.exe"),
  join(__dirname, "otel-pocket"),
  join(__dirname, "..", "otel-pocket.exe"),
  join(__dirname, "..", "otel-pocket"),
].filter(Boolean);

const native = candidates.find((p) => existsSync(p));
if (native) {
  const result = spawnSync(native, argv, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

const { runCli } = await import("../dist/cli.js");
const code = await runCli(argv);
process.exit(code);
