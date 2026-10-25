# otel-pocket

**One command** local OpenTelemetry: `npx otel-pocket` listens on `:4318` for OTLP/JSON traces, renders a live terminal flamegraph, flags SQL N+1 loops, and surfaces `gen_ai.*` LLM spans (Ollama, OpenAI, Anthropic).

## Quick start

```bash
npx otel-pocket
# point your SDK exporter to http://127.0.0.1:4318/v1/traces
```

```bash
go install github.com/kanchingyg/otel-pocket@latest
otel-pocket
```

```bash
npx otel-pocket --mcp
```

Add to Cursor / Claude Code MCP config:

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

The core collector runs in **Go** (`main.go`, `internal/`). TypeScript under `src/*.ts` is vendored for `npx` fallback and MCP bridge helpers (six production blindajes).

### MCP tools

| Tool | Purpose |
| --- | --- |
| `list_recent_traces` | Recent traces with duration / errors |
| `inspect_trace_tree` | Span tree, critical path, N+1 SQL, `gen_ai` metrics (SQL redacted unless `verbose` or `OTEL_POCKET_VERBOSE_MCP=1`) |
| `diagnose_slow_trace` | Ask a local OpenAI-compatible model (Ollama/LM Studio); loopback-only unless `OTEL_POCKET_ALLOW_REMOTE_LLM=1` |

Set `OTEL_POCKET_LLM_URL` / `OTEL_POCKET_LLM_MODEL` for diagnosis.

## Why otel-pocket

Jaeger and desktop viewers need a browser, miss terminal TUI, and do not ship MCP tools for agents. Phoenix/Langfuse are heavy LLM stacks. **otel-pocket** correlates HTTP, SQL N+1, and `gen_ai.*` in one zero-config `npx` or `go install` binary.

## License

MIT
