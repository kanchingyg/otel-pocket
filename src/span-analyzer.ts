/** Configuration and data shape for `PocketSpan` (pocket span). */
export type PocketSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startNs: number;
  endNs: number;
  attributes: Record<string, string | number | boolean>;
  statusCode?: number;
};

/** Configuration and data shape for `TraceSummary` (trace summary). */
export type TraceSummary = {
  traceId: string;
  rootName: string;
  durationMs: number;
  spanCount: number;
  hasError: boolean;
};

export type N1Pattern = { statement: string; count: number; totalMs: number };

export type GenAiMetrics = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  tokensPerSec?: number;
};

export type EmbeddingAlert = {
  batchSize?: number;
  dimension?: number;
  latencyMs: number;
  message: string;
};

export type TraceAnalysis = {
  traceId: string;
  durationMs: number;
  n1: N1Pattern[];
  genAi: GenAiMetrics[];
  embeddingAlerts: EmbeddingAlert[];
  criticalPathMs: number;
};

export type TraceNode = { span: PocketSpan; children: TraceNode[]; durationMs: number };

const SQL_KEYS = ["db.statement", "db.query.text", "sql.query"];

export const MIN_TRACE_ID_PREFIX_LEN = 8;

export function matchTraceSpans(spans: PocketSpan[], traceId: string): PocketSpan[] {
  const id = traceId.trim();
  if (!id) return [];
  const exact = spans.filter((s) => s.traceId === id);
  if (exact.length > 0) return exact;
  if (id.length < MIN_TRACE_ID_PREFIX_LEN) return [];
  const prefixed = spans.filter((s) => s.traceId.startsWith(id));
  const uniqueIds = new Set(prefixed.map((s) => s.traceId));
  if (uniqueIds.size === 1) return prefixed;
  return [];
}

export function attrString(span: PocketSpan, key: string): string | undefined {
  const v = span.attributes[key];
  return typeof v === "string" ? v : undefined;
}

export function spanDurationMs(span: PocketSpan): number {
  return Math.max(0, (span.endNs - span.startNs) / 1e6);
}

export function parseOtlpJson(body: unknown): PocketSpan[] {
  const root = body as {
    resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: unknown[] }> }>;
  };
  const out: PocketSpan[] = [];
  for (const rs of root.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const raw of ss.spans ?? []) {
        const s = raw as Record<string, unknown>;
        const attrs: Record<string, string | number | boolean> = {};
        for (const a of (s.attributes as Array<{ key: string; value: Record<string, unknown> }>) ??
          []) {
          const v = a.value;
          if (typeof v.stringValue === "string") attrs[a.key] = v.stringValue;
          else if (typeof v.intValue === "string" || typeof v.intValue === "number")
            attrs[a.key] = Number(v.intValue);
          else if (typeof v.boolValue === "boolean") attrs[a.key] = v.boolValue;
        }
        out.push({
          traceId: hexId(s.traceId),
          spanId: hexId(s.spanId),
          parentSpanId: s.parentSpanId ? hexId(s.parentSpanId) : undefined,
          name: String(s.name ?? "span"),
          startNs: Number(s.startTimeUnixNano ?? 0),
          endNs: Number(s.endTimeUnixNano ?? 0),
          attributes: attrs,
          statusCode: (s.status as { code?: number })?.code,
        });
      }
    }
  }
  return out;
}

function hexId(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return Buffer.from(v as Buffer).toString("hex");
  return String(v ?? "");
}

export function groupByTrace(spans: PocketSpan[]): Map<string, PocketSpan[]> {
  const m = new Map<string, PocketSpan[]>();
  for (const s of spans) {
    const list = m.get(s.traceId) ?? [];
    list.push(s);
    m.set(s.traceId, list);
  }
  return m;
}

export function summarizeTrace(spans: PocketSpan[]): TraceSummary {
  const root =
    spans.find((s) => !s.parentSpanId) ??
    spans.reduce((a, b) => (spanDurationMs(a) >= spanDurationMs(b) ? a : b), spans[0]);
  const minStart = Math.min(...spans.map((s) => s.startNs));
  const maxEnd = Math.max(...spans.map((s) => s.endNs));
  return {
    traceId: root.traceId,
    rootName: root.name,
    durationMs: (maxEnd - minStart) / 1e6,
    spanCount: spans.length,
    hasError: spans.some((s) => s.statusCode === 2),
  };
}

export function detectN1(spans: PocketSpan[], minCount = 3): N1Pattern[] {
  const buckets = new Map<string, { count: number; totalMs: number }>();
  for (const s of spans) {
    let stmt: string | undefined;
    for (const k of SQL_KEYS) {
      stmt = attrString(s, k);
      if (stmt) break;
    }
    if (!stmt) continue;
    const norm = stmt.replace(/\s+/g, " ").trim();
    const b = buckets.get(norm) ?? { count: 0, totalMs: 0 };
    b.count++;
    b.totalMs += spanDurationMs(s);
    buckets.set(norm, b);
  }
  return [...buckets.entries()]
    .filter(([, v]) => v.count >= minCount)
    .map(([statement, v]) => ({ statement, count: v.count, totalMs: v.totalMs }))
    .sort((a, b) => b.count - a.count);
}

export function extractGenAi(spans: PocketSpan[]): GenAiMetrics[] {
  const out: GenAiMetrics[] = [];
  for (const s of spans) {
    const kind = attrString(s, "gen_ai.operation.name") ?? s.name;
    if (!kind.includes("gen_ai") && !kind.includes("chat") && !attrString(s, "gen_ai.request.model"))
      continue;
    const latencyMs = spanDurationMs(s);
    const inTok = numAttr(s, "gen_ai.usage.input_tokens") ?? numAttr(s, "gen_ai.usage.prompt_tokens");
    const outTok =
      numAttr(s, "gen_ai.usage.output_tokens") ?? numAttr(s, "gen_ai.usage.completion_tokens");
    const total = (inTok ?? 0) + (outTok ?? 0);
    out.push({
      model: attrString(s, "gen_ai.request.model") ?? attrString(s, "gen_ai.response.model"),
      inputTokens: inTok,
      outputTokens: outTok,
      latencyMs,
      tokensPerSec: total > 0 && latencyMs > 0 ? (total / latencyMs) * 1000 : undefined,
    });
  }
  return out;
}

export function auditEmbeddings(spans: PocketSpan[]): EmbeddingAlert[] {
  const alerts: EmbeddingAlert[] = [];
  for (const s of spans) {
    const op = attrString(s, "gen_ai.operation.name") ?? s.name;
    if (!op.includes("embed")) continue;
    const batch = numAttr(s, "gen_ai.embeddings.batch_size");
    const dim = numAttr(s, "gen_ai.embeddings.dimension");
    const latencyMs = spanDurationMs(s);
    if (batch !== undefined && batch > 10) {
      alerts.push({
        batchSize: batch,
        dimension: dim,
        latencyMs,
        message: `Embedding batch ${batch} exceeds safe threshold (>10)`,
      });
    }
    if (batch !== undefined && batch > 32) {
      alerts.push({
        batchSize: batch,
        dimension: dim,
        latencyMs,
        message: `Embedding batch ${batch} may exceed TEI/Qdrant limits (>32)`,
      });
    }
    if (dim !== undefined && ![384, 768, 1024, 1536, 2560, 3072, 4096].includes(dim)) {
      alerts.push({
        batchSize: batch,
        dimension: dim,
        latencyMs,
        message: `Unusual embedding dimension ${dim} — verify vector store lockfile`,
      });
    }
  }
  return alerts;
}

function numAttr(span: PocketSpan, key: string): number | undefined {
  const v = span.attributes[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return undefined;
}

export function analyzeTrace(spans: PocketSpan[]): TraceAnalysis {
  const traceId = spans[0]?.traceId ?? "";
  const minStart = Math.min(...spans.map((s) => s.startNs));
  const maxEnd = Math.max(...spans.map((s) => s.endNs));
  const tree = buildTraceTree(spans);
  return {
    traceId,
    durationMs: (maxEnd - minStart) / 1e6,
    n1: detectN1(spans),
    genAi: extractGenAi(spans),
    embeddingAlerts: auditEmbeddings(spans),
    criticalPathMs: criticalPathMs(tree),
  };
}

export function buildTraceTree(spans: PocketSpan[]): TraceNode[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string, PocketSpan[]>();
  for (const s of spans) {
    const pid = s.parentSpanId ?? "";
    const list = children.get(pid) ?? [];
    list.push(s);
    children.set(pid, list);
  }
  const build = (s: PocketSpan): TraceNode => ({
    span: s,
    durationMs: spanDurationMs(s),
    children: (children.get(s.spanId) ?? [])
      .sort((a, b) => a.startNs - b.startNs)
      .map(build),
  });
  const roots = spans.filter((s) => !s.parentSpanId || !byId.has(s.parentSpanId));
  return roots.length ? roots.map(build) : spans.slice(0, 1).map(build);
}

function criticalPathMs(nodes: TraceNode[]): number {
  let best = 0;
  for (const n of nodes) {
    const childMax = n.children.length ? criticalPathMs(n.children) : 0;
    best = Math.max(best, n.durationMs + childMax);
  }
  return best;
}

export function collapseN1Lines(spans: PocketSpan[]): string[] {
  const n1 = detectN1(spans, 3);
  const lines: string[] = [];
  const collapsed = new Set(n1.map((p) => p.statement));
  const seen = new Set<string>();
  for (const s of spans) {
    let stmt: string | undefined;
    for (const k of SQL_KEYS) stmt = attrString(s, k) ?? stmt;
    const norm = stmt?.replace(/\s+/g, " ").trim();
    if (norm && collapsed.has(norm)) {
      if (!seen.has(norm)) {
        const p = n1.find((x) => x.statement === norm)!;
        lines.push(`${p.count}x ${p.statement.slice(0, 80)} [total ${Math.round(p.totalMs)}ms]`);
        seen.add(norm);
      }
      continue;
    }
    lines.push(`${s.name} (${Math.round(spanDurationMs(s))}ms)`);
  }
  return lines;
}

export function formatTraceTreeText(nodes: TraceNode[], indent = 0): string {
  const pad = "  ".repeat(indent);
  return nodes
    .map((n) => {
      const head = `${pad}${n.span.name} ${Math.round(n.durationMs)}ms`;
      const child = formatTraceTreeText(n.children, indent + 1);
      return child ? `${head}\n${child}` : head;
    })
    .join("\n");
}

export function formatTraceTreeCli(spans: PocketSpan[]): string {
  const analysis = analyzeTrace(spans);
  const tree = formatTraceTreeText(buildTraceTree(spans));
  const n1 =
    analysis.n1.length === 0
      ? "N+1: none"
      : `N+1: ${analysis.n1.map((p) => `${p.count}x ${p.statement.slice(0, 40)}`).join("; ")}`;
  const gen =
    analysis.genAi.length === 0
      ? ""
      : `\nGenAI: ${analysis.genAi
          .map(
            (g) =>
              `${g.model ?? "model"} ${g.latencyMs.toFixed(0)}ms` +
              (g.tokensPerSec ? ` ${g.tokensPerSec.toFixed(1)} tok/s` : ""),
          )
          .join("; ")}`;
  return `trace ${analysis.traceId.slice(0, 16)}… ${analysis.durationMs.toFixed(1)}ms\n${n1}\n${tree}${gen}`;
}

export function filterTraces(
  summaries: TraceSummary[],
  opts: { minDurationMs?: number; errorsOnly?: boolean },
): TraceSummary[] {
  return summaries.filter((t) => {
    if (opts.errorsOnly && !t.hasError) return false;
    if (opts.minDurationMs !== undefined && t.durationMs < opts.minDurationMs) return false;
    return true;
  });
}

export function truncateForModel(text: string, nCtx: number): string {
  const max = Math.floor(nCtx * 4 * 0.45);
  if (text.length <= max) return text;
  const marker = "[...TRUNCATED BY OTEL-POCKET...]";
  const head = Math.floor(max * 0.6);
  const tail = max - head - marker.length;
  return text.slice(0, head) + marker + text.slice(-Math.max(0, tail));
}
