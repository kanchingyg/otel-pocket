import type { N1Pattern, PocketSpan, TraceAnalysis } from "./span-analyzer.js";

export const REDACTED = "[REDACTED]";

const SENSITIVE_ATTR_PREFIX =
  /^(db\.statement|db\.query\.text|sql\.query|url\.full|http\.(request|response)\.header\.)/i;

export function isSensitiveSpanAttributeKey(key: string): boolean {
  if (SENSITIVE_ATTR_PREFIX.test(key)) return true;
  return /authorization/i.test(key);
}

export function redactSecretsInString(text: string): string {
  return String(text)
    .replace(/(api[_-]?key|authorization|bearer|token|password|secret)\s*[:=]\s*\S+/gi, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]");
}

export function redactSpanAttributes(
  attrs: Record<string, string | number | boolean>,
  verbose: boolean,
): Record<string, string | number | boolean> {
  if (verbose) return { ...attrs };
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (isSensitiveSpanAttributeKey(k)) {
      out[k] = REDACTED;
    } else if (typeof v === "string") {
      out[k] = redactSecretsInString(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function redactN1Pattern(pattern: N1Pattern, verbose: boolean): N1Pattern {
  if (verbose) return pattern;
  return { ...pattern, statement: REDACTED };
}

export function redactCollapsedLine(line: string, verbose: boolean): string {
  if (verbose) return line;
  const m = line.match(/^(\d+x\s+).+(\s+\[total\s+\d+ms\])$/);
  if (m) return `${m[1]}${REDACTED}${m[2]}`;
  return redactSecretsInString(line);
}

export function redactTreeText(tree: string, spans: PocketSpan[], verbose: boolean): string {
  if (verbose) return tree;
  let out = tree;
  for (const span of spans) {
    for (const [key, value] of Object.entries(span.attributes)) {
      if (typeof value !== "string") continue;
      if (isSensitiveSpanAttributeKey(key) || value.length > 0) {
        if (isSensitiveSpanAttributeKey(key) || /https?:\/\//i.test(value)) {
          out = out.split(value).join(REDACTED);
        }
      }
    }
  }
  return redactSecretsInString(out);
}

export type InspectTraceResult = {
  traceId: string;
  durationMs: number;
  criticalPathMs: number;
  n1: N1Pattern[];
  genAi: TraceAnalysis["genAi"];
  embeddingAlerts: TraceAnalysis["embeddingAlerts"];
  tree: string;
  collapsed: string[];
};

export function sanitizeInspectTraceResult(
  result: InspectTraceResult,
  spans: PocketSpan[],
  verbose: boolean,
): InspectTraceResult {
  if (verbose) return result;
  return {
    ...result,
    n1: result.n1.map((p) => redactN1Pattern(p, verbose)),
    collapsed: result.collapsed.map((line) => redactCollapsedLine(line, verbose)),
    tree: redactTreeText(result.tree, spans, verbose),
  };
}

export function inspectVerboseFromArgs(args: Record<string, unknown>): boolean {
  if (args.verbose === true) return true;
  return process.env.OTEL_POCKET_VERBOSE_MCP === "1";
}
