# otel-pocket

[![ci](https://github.com/kanchingyg/otel-pocket/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/otel-pocket/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/otel-pocket/latest?label=npm)](https://www.npmjs.com/package/otel-pocket)
[![JSR](https://jsr.io/badges/@kanchingyg/otel-pocket)](https://jsr.io/@kanchingyg/otel-pocket)
[![JSR Score](https://jsr.io/badges/@kanchingyg/otel-pocket/score)](https://jsr.io/@kanchingyg/otel-pocket/score)
[![Go](https://img.shields.io/badge/engine-Go_%2B_TypeScript-00ADD8)](https://github.com/kanchingyg/otel-pocket)
[![license](https://img.shields.io/github/license/kanchingyg/otel-pocket)](https://github.com/kanchingyg/otel-pocket/blob/HEAD/LICENSE)

**One command** local OpenTelemetry collector: `npx otel-pocket` (or `bunx otel-pocket`) listens on `:4318` for OTLP/JSON traces, renders a live terminal flamegraph, flags SQL N+1 loops, and surfaces `gen_ai.*` LLM spans (Ollama, OpenAI, Anthropic).

## Install

[Bun](https://bun.sh) / [npm](https://www.npmjs.com/package/otel-pocket):

```bash
bunx otel-pocket
npx otel-pocket

# or install in your project / globally
bun add -d otel-pocket
npm i -D otel-pocket
```

[JSR](https://jsr.io/@kanchingyg/otel-pocket):

```bash
bunx jsr add @kanchingyg/otel-pocket
npx jsr add @kanchingyg/otel-pocket
```

[Go (native binary)](https://github.com/kanchingyg/otel-pocket):

```bash
go install github.com/kanchingyg/otel-pocket@latest
```

The core collector runs in **Go** (`main.go`, `internal/`). TypeScript under `src/*.ts` is included for `npx` / `bunx` / JSR usage and MCP bridge helpers.

## Quick start

```bash
npx otel-pocket
bunx otel-pocket
# point your SDK exporter to http://127.0.0.1:4318/v1/traces
```

```bash
npx otel-pocket --mcp
```

Add to Cursor or Claude Code MCP config:

```json
{
  "mcpServers": {
    "otel-pocket": {
      "command": "npx",
      "args": ["-y", "otel-pocket", "--mcp"]
    }
  }
}
```

### MCP tools

| Tool | Purpose |
| --- | --- |
| `list_recent_traces` | Recent traces with duration and error status |
| `inspect_trace_tree` | Span tree, critical path, N+1 SQL, and `gen_ai` metrics (SQL redacted unless `verbose` or `OTEL_POCKET_VERBOSE_MCP=1`) |
| `diagnose_slow_trace` | Ask a local OpenAI-compatible model (Ollama/LM Studio); loopback-only unless `OTEL_POCKET_ALLOW_REMOTE_LLM=1` |

Set `OTEL_POCKET_LLM_URL` / `OTEL_POCKET_LLM_MODEL` for local LLM diagnosis.

## Why otel-pocket

Jaeger and desktop viewers require a browser, lack a terminal TUI, and do not ship MCP tools for coding agents. Phoenix and Langfuse are heavy Python/Docker stacks. **otel-pocket** correlates HTTP, SQL N+1, and `gen_ai.*` spans in a single zero-config `npx`, `bunx`, or `go install` binary.

## MCP Tools Reference

| Tool | Mutates | Description |
| --- | --- | --- |
| `list_recent_traces` | `false` | List recent OTLP traces stored in memory with total duration, span count, and error status. |
| `inspect_trace_tree` | `false` | Render the hierarchical span tree, critical path, collapsed SQL N+1 loops, and `gen_ai.*` token metrics (SQL/URLs redacted unless `verbose: true`). |
| `diagnose_slow_trace` | `false` | Send a sanitized trace summary to a loopback Ollama or OpenAI-compatible model for bottleneck analysis. |

## Editor and Agent Integration

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "otel-pocket": {
      "command": "npx",
      "args": ["-y", "otel-pocket", "--mcp"]
    }
  }
}
```

### Claude Code CLI

```bash
claude mcp add otel-pocket -- npx -y otel-pocket --mcp
```

### Programmatic Usage (JSR / TypeScript)

```ts
import * as bridge from "jsr:@kanchingyg/otel-pocket/bridge";
```

## Runtime Safety and Guardrails

- **Stdio frame isolation**: When `--mcp` is active, `hijackStdoutForMcp()` redirects accidental `console.log` calls to `stderr` so JSON-RPC 2.0 frames on `stdout` never corrupt.
- **Read-only by default**: Mutating tools (`mutates: true`) are blocked in `--dry-run` mode and require explicit `--allow-write` authorization.
- **Loop breaker**: Repeated identical `(toolName, args)` invocations are hashed with SHA-256 and halted after 3 consecutive repeats to prevent runaway agent loops.
- **Context budget truncation**: Tool outputs are middle-truncated (`60%` head / `40%` tail) scaled to the probed local model `n_ctx` (Ollama `/api/show`, llama.cpp `/props`, vLLM `/v1/models`).
- **Secret redaction and path normalization**: AWS keys (`AKIA*`, `ASIA*`), bearer tokens, and `sk-*` keys are scrubbed before returning tool output, and Windows drive paths (`C:\...`) translate cleanly to `/mnt/c/...` when WSL mode is enabled.

## License

[MIT](./LICENSE)
