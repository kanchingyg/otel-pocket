#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { createTraceStore, createOtlpServer } from "./otlp-server.js";
import { buildOtelMcpTools, setGuards, startMcpServer } from "./bridge.js";
import { renderLiveFrame } from "./tui-render.js";
const DEFAULT_PORT = 4318;
export function parseArgv(argv: string[]) {
    let port = DEFAULT_PORT;
    let mcp = false;
    let dryRun = false;
    let allowWrite = false;
    let help = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--mcp")
            mcp = true;
        else if (a === "--dry-run")
            dryRun = true;
        else if (a === "--allow-write")
            allowWrite = true;
        else if (a === "--help" || a === "-h")
            help = true;
        else if (a === "--port" && argv[i + 1]) {
            port = parseInt(argv[++i], 10);
            if (Number.isNaN(port))
                process.exit(2);
        }
    }
    return { port, mcp, dryRun, allowWrite, help };
}
export async function runCli(argv: string[]): Promise<number> {
    const opts = parseArgv(argv);
    if (opts.help) {
        process.stderr.write("otel-pocket — local OTLP :4318 collector with TUI + MCP\n\n" +
            "  npx otel-pocket [--port 4318]\n" +
            "  npx otel-pocket --mcp\n");
        return 0;
    }
    const store = createTraceStore(200);
    if (opts.mcp) {
        setGuards({ allowWrite: opts.allowWrite, dryRun: opts.dryRun });
        createOtlpServer(opts.port, store);
        startMcpServer({ name: "otel-pocket", version: "0.1.0" }, buildOtelMcpTools(store), { allowWrite: opts.allowWrite });
        return 0;
    }
    createOtlpServer(opts.port, store);
    process.stderr.write(`otel-pocket listening on http://127.0.0.1:${opts.port}/v1/traces\n`);
    const tick = () => {
        const last = store.spans.slice(-80);
        process.stderr.write("\x1b[2J\x1b[H" + renderLiveFrame(last, opts.port) + "\n");
    };
    tick();
    setInterval(tick, 2000);
    return 0;
}
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
    runCli(process.argv.slice(2)).then((code) => {
        if (code !== 0)
            process.exit(code);
    });
}