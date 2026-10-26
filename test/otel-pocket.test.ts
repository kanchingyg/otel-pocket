import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

import {
  analyzeTrace,
  collapseN1Lines,
  detectN1,
  formatTraceTreeCli,
  matchTraceSpans,
  parseOtlpJson,
} from "../src/span-analyzer.js";
import {
  createTraceStore,
  createOtlpServer,
  ingestOtlpJson,
  MAX_INGEST_BODY_BYTES,
} from "../src/otlp-server.js";
import { assertLoopbackLlmBaseUrl } from "../src/llm-guard.js";
import { REDACTED, sanitizeInspectTraceResult } from "../src/trace-redact.js";
import {
  hijackStdoutForMcp,
  jsonRpcFrameLog,
  dispatchMcpMessage,
  setGuards,
  resetLoopBreaker,
  checkLoopBreaker,
  guardMutatingTool,
  windowsToWsl,
  wslToWindows,
  headTailTruncate,
  buildRecencyAnchor,
  anchorPromptTail,
  applyReasoningContentPolicy,
  createReasoningState,
  parseDirtyToolCall,
  StreamToolJsonAbort,
  sanitizeRequestBody,
  normalizeToolChoice,
  detectProvider,
  normalizeEmbedBatch,
  floatArrayToBase64,
  base64ToFloatArray,
  mrlSlice,
  assertDimensionFingerprint,
  writeEmbedLock,
  readEmbedLock,
  EMBED_LOCK,
  buildOtelMcpTools,
  diagnoseWithOpenAiCompat,
} from "../src/bridge.js";

function fixturePayload(traceId = "abc123trace") {
  const sql = "SELECT * FROM items WHERE id = ?";
  const spans = [
    {
      traceId,
      spanId: "root1",
      name: "HTTP GET /api/items",
      startTimeUnixNano: "1000000000",
      endTimeUnixNano: "2800000000",
      attributes: [],
    },
    ...Array.from({ length: 8 }, (_, i) => ({
      traceId,
      spanId: `sql${i}`,
      parentSpanId: "root1",
      name: "db.query",
      startTimeUnixNano: String(1100000000 + i * 100000000),
      endTimeUnixNano: String(1150000000 + i * 100000000),
      attributes: [{ key: "db.statement", value: { stringValue: sql } }],
    })),
    {
      traceId,
      spanId: "genai1",
      parentSpanId: "root1",
      name: "gen_ai.chat",
      startTimeUnixNano: "2000000000",
      endTimeUnixNano: "2500000000",
      attributes: [
        { key: "gen_ai.request.model", value: { stringValue: "llama3.2" } },
        { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: "40" } },
      ],
    },
  ];
  return { resourceSpans: [{ scopeSpans: [{ spans }] }] };
}

describe("OTLP ingest and N+1", () => {
  it("detects N+1 SQL and gen_ai from OTLP JSON", () => {
    const spans = parseOtlpJson(fixturePayload());
    expect(spans.length).toBe(10);
    expect(detectN1(spans)[0]?.count).toBe(8);
    expect(analyzeTrace(spans).genAi[0].tokensPerSec).toBeGreaterThan(0);
    expect(formatTraceTreeCli(spans)).toContain("8x");
  });

  it("serves POST /v1/traces and MCP inspect_trace_tree", async () => {
    const store = createTraceStore(50);
    const port = 43180 + Math.floor(Math.random() * 1000);
    const server = createOtlpServer(port, store);
    await ingestOtlpJson(port, fixturePayload("trace-mcp-1"));
    const handler = buildOtelMcpTools(store).find((t) => t.name === "inspect_trace_tree")!.handler;
    const result = (await handler({ traceId: "trace-mcp-1" }, {
      dryRun: false,
      allowWrite: false,
      nCtx: 4096,
    })) as { n1: Array<{ count: number; statement: string }> };
    expect(result.n1[0].count).toBe(8);
    expect(result.n1[0].statement).toBe(REDACTED);
    server.close();
  });

  it("rejects ingest payloads over cap", async () => {
    const store = createTraceStore(5);
    const port = 44180 + Math.floor(Math.random() * 1000);
    const cap = 512;
    const server = createOtlpServer(port, store, { maxIngestBytes: cap });
    const res = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(cap + 1),
    });
    expect(res.status).toBe(413);
    expect(MAX_INGEST_BODY_BYTES).toBe(32 * 1024 * 1024);
    server.close();
  });

  it("requires min traceId prefix length for ambiguous lookup", () => {
    const spans = parseOtlpJson(fixturePayload("abcdef1234567890"));
    expect(matchTraceSpans(spans, "abc")).toHaveLength(0);
    expect(matchTraceSpans(spans, "abcdef12").length).toBeGreaterThan(0);
  });
});

describe("MCP JSON-RPC", () => {
  let stderrChunks: string[];

  beforeEach(() => {
    stderrChunks = [];
    jsonRpcFrameLog.length = 0;
    resetLoopBreaker();
    const nativeStderr = process.stderr.write.bind(process.stderr);
    hijackStdoutForMcp();
    process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
      stderrChunks.push(String(chunk));
      return nativeStderr(chunk as Buffer, ...(args as [BufferEncoding?, (err?: Error) => void?]));
    }) as typeof process.stderr.write;
  });

  it("initialize and tools/list handshake", () => {
    const store = createTraceStore(10);
    const tools = buildOtelMcpTools(store).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { tools, serverInfo: { name: "otel-pocket", version: "0.1.0" } },
    );
    dispatchMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { tools });
    const frames = jsonRpcFrameLog.map((l) => JSON.parse(l.trim()));
    expect(frames[0].result.serverInfo.name).toBe("otel-pocket");
    expect(frames[1].result.tools.length).toBe(3);
  });

  it("routes tool noise to stderr and normalizes windows paths", async () => {
    const tool = {
      name: "echo_path",
      description: "echo",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    };
    dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo_path", arguments: { path: "C:\\proj\\foo.ts" } },
      },
      {
        tools: [tool],
        pathToWsl: true,
        handlers: {
          echo_path: async (args) => {
            process.stdout.write("NOISE\n");
            return args;
          },
        },
      },
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(stderrChunks.join("")).toContain("NOISE");
    const last = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(last.result.content[0].text).toContain("/mnt/c/proj/foo.ts");
  });
});

describe("Blindaje 1", () => {
  beforeEach(() => {
    resetLoopBreaker();
    setGuards({ allowWrite: false, dryRun: false });
  });

  it("blocks mutating tools", () => {
    expect(
      guardMutatingTool({
        name: "x",
        mutates: true,
      }).blocked,
    ).toBe(true);
  });

  it("blocks mutating tools in dry-run", () => {
    setGuards({ dryRun: true, allowWrite: true });
    const g = guardMutatingTool({ name: "write_thing", mutates: true });
    expect(g.blocked).toBe(true);
    expect(g.reason).toMatch(/dry-run/);
  });

  it("loop breaker on third identical call", () => {
    expect(checkLoopBreaker("t", { a: 1 })).toBeNull();
    expect(checkLoopBreaker("t", { a: 1 })).toBeNull();
    expect(checkLoopBreaker("t", { a: 1 })).toMatch(/LOOP_BREAKER/);
  });
});

describe("Blindaje 2", () => {
  it("head+tail truncation", () => {
    const out = headTailTruncate("H".repeat(200) + "T".repeat(200), 200);
    expect(out).toContain("TRUNCATED");
    expect(out.startsWith("HHH")).toBe(true);
  });

  it("recency anchor before ASSISTANT", () => {
    const anchor = buildRecencyAnchor([{ name: "inspect_trace_tree", summary: "tree" }]);
    const anchored = anchorPromptTail("SYSTEM\nASSISTANT:", anchor);
    expect(anchored.indexOf(anchor)).toBeLessThan(anchored.lastIndexOf("ASSISTANT:"));
  });
});

describe("Blindaje 5", () => {
  it("reasoning_content replay vs strip", () => {
    let state = createReasoningState();
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", reasoning_content: "think", tool_calls: [{}] },
      { role: "tool", content: "{}" },
    ];
    const r1 = applyReasoningContentPolicy(msgs, state);
    expect(r1.messages[1].reasoning_content).toBe("think");
    state = r1.state;
    const r2 = applyReasoningContentPolicy(
      [...msgs, { role: "user", content: "next" }, { role: "assistant", content: "done", reasoning_content: "old" }],
      state,
    );
    expect(r2.messages[1].reasoning_content).toBeUndefined();
  });

  it("parses Kimi GLM Qwen and IQ1 JSON", () => {
    const kimi =
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.run:0<|tool_call_argument_begin|>{"target":"x"}<|tool_call_end|>';
    expect(parseDirtyToolCall(kimi)?.name).toBe("run");
    const glm =
      '<|tool_call_begin|>run_check<|tool_call_sep|>{"target":"a"}<|tool_call_end|>';
    expect(parseDirtyToolCall(glm)?.arguments.target).toBe("a");
    expect(parseDirtyToolCall("✿FUNCTION✿: run_check\n✿ARGS✿: {'target': 'z'}\n")?.name).toBe(
      "run_check",
    );
    expect(parseDirtyToolCall("{'cmd': 'ls'}")?.arguments).toEqual({ cmd: "ls" });
  });

  it("stream abort when tool JSON closes", () => {
    const guard = new StreamToolJsonAbort();
    expect(guard.feed('<tool_call>{"name":"t","arguments":{')).toBe(false);
    expect(guard.feed("}}")).toBe(true);
  });

  it("provider sanitization", () => {
    const body = sanitizeRequestBody(
      { temperature: 0.2, top_p: 0.9, model: "deepseek-reasoner" },
      "deepseek-reasoner",
    );
    expect(body.temperature).toBeUndefined();
    expect(normalizeToolChoice("required", detectProvider("https://dashscope.aliyuncs.com"))).toBe(
      "auto",
    );
  });
});

describe("Blindaje 3 embed", () => {
  it("splits 60 into batches of 10", async () => {
    const calls: number[] = [];
    await normalizeEmbedBatch(Array.from({ length: 60 }, (_, i) => `t-${i}`), {
      upstream: {
        name: "dashscope",
        maxBatch: 10,
        embed: async (input: string[]) => {
          calls.push(input.length);
          return input.map(() => [1, 0, 0]);
        },
      },
      model: "text-embedding-v3",
      dimensions: 3,
    });
    expect(calls.length).toBe(6);
  });

  it("float base64 and dimension lock", () => {
    expect(base64ToFloatArray(floatArrayToBase64([3, 4]))[0]).toBeCloseTo(3);
    expect(Math.hypot(...mrlSlice([3, 4, 0], 2))).toBeCloseTo(1);
    expect(() => assertDimensionFingerprint({ provider: "x", model: "m", dimension: 1024 }, 768)).toThrow(
      /fingerprint/,
    );
    const dir = mkdtempSync(join(tmpdir(), "otel-pocket-"));
    writeEmbedLock(dir, { provider: "p", model: "m", dimension: 1024 });
    expect(readEmbedLock(dir)?.dimension).toBe(1024);
    expect(existsSync(join(dir, EMBED_LOCK))).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

describe("trace redaction", () => {
  it("verbose inspect exposes SQL", () => {
    const spans = parseOtlpJson(fixturePayload());
    const analysis = analyzeTrace(spans);
    const raw = {
      traceId: analysis.traceId,
      durationMs: analysis.durationMs,
      criticalPathMs: analysis.criticalPathMs,
      n1: analysis.n1,
      genAi: analysis.genAi,
      embeddingAlerts: analysis.embeddingAlerts,
      tree: "HTTP GET",
      collapsed: collapseN1Lines(spans),
    };
    const redacted = sanitizeInspectTraceResult(raw, spans, false);
    const verbose = sanitizeInspectTraceResult(raw, spans, true);
    expect(redacted.n1[0]?.statement).toBe(REDACTED);
    expect(verbose.n1[0]?.statement).toContain("SELECT");
    expect(JSON.stringify(redacted)).not.toContain("Bearer sk-");
  });
});

describe("Ollama OpenAI-compat diagnose", () => {
  it("blocks non-loopback LLM baseUrl", () => {
    expect(() => assertLoopbackLlmBaseUrl("https://api.openai.com")).toThrow(/Non-loopback/);
  });

  it("redacts secrets from prompt before LLM fetch", async () => {
    let capturedBody = "";
    const srv = createServer((req, res) => {
      if (req.url === "/v1/chat/completions") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          capturedBody = Buffer.concat(chunks).toString("utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await diagnoseWithOpenAiCompat(
      `http://127.0.0.1:${port}`,
      "llama3.2",
      "token=supersecret12345",
    );
    expect(capturedBody).toContain("[REDACTED]");
    expect(capturedBody).not.toContain("supersecret12345");
    srv.close();
  });

  it("calls /v1/chat/completions", async () => {
    const srv = createServer((req, res) => {
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "N+1 queries dominate latency." } }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const out = await diagnoseWithOpenAiCompat(`http://127.0.0.1:${port}`, "llama3.2", "trace?");
    expect(out.diagnosis).toContain("N+1");
    srv.close();
  });
});

describe("path normalize", () => {
  it("windows and wsl", () => {
    expect(windowsToWsl("C:\\proj\\foo.ts")).toBe("/mnt/c/proj/foo.ts");
    expect(wslToWindows("/mnt/c/proj/foo.ts")).toBe("C:\\proj\\foo.ts");
  });
});
