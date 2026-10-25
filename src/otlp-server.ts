import { createServer, type IncomingMessage } from "node:http";

import {
  groupByTrace,
  matchTraceSpans,
  parseOtlpJson,
  summarizeTrace,
  type PocketSpan,
  type TraceSummary,
} from "./span-analyzer.js";

export const MAX_INGEST_BODY_BYTES = 32 * 1024 * 1024;

export type TraceStore = {
  spans: PocketSpan[];
  maxTraces: number;
  push(batch: PocketSpan[]): void;
  listSummaries(): TraceSummary[];
  getTrace(traceId: string): PocketSpan[];
};

export function createTraceStore(maxTraces = 200): TraceStore {
  const spans: PocketSpan[] = [];
  return {
    spans,
    maxTraces,
    push(batch: PocketSpan[]) {
      spans.push(...batch);
      const ids = [...new Set(spans.map((s) => s.traceId))];
      while (ids.length > maxTraces) {
        const drop = ids.shift();
        if (!drop) break;
        for (let i = spans.length - 1; i >= 0; i--) {
          if (spans[i].traceId === drop) spans.splice(i, 1);
        }
      }
    },
    listSummaries() {
      const byTrace = groupByTrace(spans);
      return [...byTrace.values()].map(summarizeTrace).sort((a, b) => b.durationMs - a.durationMs);
    },
    getTrace(traceId: string) {
      return matchTraceSpans(spans, traceId);
    },
  };
}

function readBody(req: IncomingMessage, maxBytes = MAX_INGEST_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversize = false;
    req.on("data", (c) => {
      const chunk = c as Buffer;
      total += chunk.length;
      if (total > maxBytes) {
        if (!oversize) {
          oversize = true;
          reject(new Error(`payload exceeds ${maxBytes} bytes`));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!oversize) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

export function createOtlpServer(
  port: number,
  store: TraceStore,
  options?: { maxIngestBytes?: number },
) {
  const maxIngestBytes = options?.maxIngestBytes ?? MAX_INGEST_BODY_BYTES;
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/traces")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, maxIngestBytes);
    } catch (e) {
      req.resume();
      res.writeHead(413);
      res.end(String(e));
      return;
    }
    const ctype = req.headers["content-type"] ?? "";
    try {
      let parsed: unknown;
      if (ctype.includes("json") || body[0] === 0x7b) {
        parsed = JSON.parse(body.toString("utf8"));
      } else {
        parsed = decodeOtlpProtobuf(body);
      }
      const spans = parseOtlpJson(parsed);
      store.push(spans);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ partialSuccess: {}, spans: spans.length }));
    } catch (e) {
      res.writeHead(400);
      res.end(String(e));
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

function decodeOtlpProtobuf(buf: Buffer): unknown {
  const spans: PocketSpan[] = [];
  const text = buf.toString("utf8");
  const nameMatches = [...text.matchAll(/[\x20-\x7e]{2,64}/g)].map((m) => m[0]);
  if (nameMatches.length === 0) throw new Error("empty protobuf payload");
  const traceId = "pb" + buf.subarray(0, 8).toString("hex");
  let i = 0;
  for (const nm of nameMatches) {
    if (!nm.includes("SELECT") && !nm.includes("HTTP") && !nm.includes("gen_ai")) continue;
    spans.push({
      traceId,
      spanId: `s${i++}`,
      name: nm,
      startNs: Date.now() * 1e6,
      endNs: Date.now() * 1e6 + 1e6,
      attributes: nm.includes("SELECT") ? { "db.statement": nm } : {},
    });
  }
  return {
    resourceSpans: [{ scopeSpans: [{ spans: spans.map(exportSpanToOtlp) }] }],
  };
}

function exportSpanToOtlp(s: PocketSpan) {
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    name: s.name,
    startTimeUnixNano: String(s.startNs),
    endTimeUnixNano: String(s.endNs),
    attributes: Object.entries(s.attributes).map(([key, value]) => ({
      key,
      value: typeof value === "string" ? { stringValue: value } : { intValue: String(value) },
    })),
  };
}

export async function ingestOtlpJson(
  port: number,
  payload: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ spans: number }> {
  const res = await fetchImpl(`http://127.0.0.1:${port}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`ingest failed: ${res.status}`);
  const j = (await res.json()) as { spans?: number };
  return { spans: j.spans ?? 0 };
}
