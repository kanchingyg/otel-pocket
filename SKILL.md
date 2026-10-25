---
name: otel-pocket
description: Local OTLP collector on :4318 with TUI flamegraphs, SQL N+1 detection, gen_ai spans, and MCP trace tools.
---

# otel-pocket

Run `npx otel-pocket` (collector + TUI) or `npx otel-pocket --mcp` for agent tools.

## MCP tools

- `list_recent_traces({ minDurationMs?, errorsOnly? })`
- `inspect_trace_tree({ traceId })` — tree, N+1 SQL, `gen_ai.*` tokens/latency
- `diagnose_slow_trace({ traceId, model?, baseUrl? })` — local Ollama / OpenAI-compatible LLM

Point OTLP HTTP exporter to `http://127.0.0.1:4318/v1/traces`.

Read-only in-memory ring buffer; use `--dry-run` on MCP for plan-only tool calls.
