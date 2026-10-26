import type { PocketSpan } from "./span-analyzer.js";
import { buildTraceTree, spanDurationMs, type TraceNode } from "./span-analyzer.js";

const BAR = "▇";

export function flameWidth(durationMs: number, maxMs: number, cols = 40): number {
  if (maxMs <= 0) return 1;
  return Math.max(1, Math.round((durationMs / maxMs) * cols));
}

export function renderFlameLine(label: string, durationMs: number, maxMs: number): string {
  const w = flameWidth(durationMs, maxMs);
  return `${BAR.repeat(w).padEnd(42)} ${label} ${durationMs.toFixed(1)}ms`;
}

export function collectFlameRows(nodes: TraceNode[], maxMs: number, depth = 0): string[] {
  const lines: string[] = [];
  for (const n of nodes) {
    lines.push(renderFlameLine(" ".repeat(depth * 2) + n.span.name, n.durationMs, maxMs));
    lines.push(...collectFlameRows(n.children, maxMs, depth + 1));
  }
  return lines;
}

export function renderFlamegraph(spans: PocketSpan[]): string {
  if (!spans.length) return "(no spans)";
  const tree = buildTraceTree(spans);
  const maxMs = Math.max(...spans.map(spanDurationMs), 1);
  return [`otel-pocket flamegraph (max ${maxMs.toFixed(1)}ms)`, ...collectFlameRows(tree, maxMs)].join(
    "\n",
  );
}

export function renderLiveFrame(spans: PocketSpan[], port: number): string {
  return [`:4318 → ${port} | traces buffered`, renderFlamegraph(spans)].join("\n");
}
