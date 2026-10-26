package tui

import (
	"fmt"
	"math"
	"strings"

	"github.com/kanchingyg/otel-pocket/internal/analyze"
)

const bar = "▇"

func RenderLiveFrame(spans []analyze.Span, port int) string {
	return fmt.Sprintf(":4318 → %d | traces buffered\n%s", port, RenderFlamegraph(spans))
}

func RenderFlamegraph(spans []analyze.Span) string {
	if len(spans) == 0 {
		return "(no spans)"
	}
	tree := analyze.BuildTraceTree(spans)
	maxMs := 1.0
	for _, s := range spans {
		maxMs = math.Max(maxMs, analyze.SpanDurationMs(s))
	}
	lines := []string{fmt.Sprintf("otel-pocket flamegraph (max %.1fms)", maxMs)}
	lines = append(lines, collectFlameRows(tree, maxMs, 0)...)
	return strings.Join(lines, "\n")
}

func collectFlameRows(nodes []analyze.TraceNode, maxMs float64, depth int) []string {
	var lines []string
	for _, n := range nodes {
		label := strings.Repeat(" ", depth*2) + n.Span.Name
		lines = append(lines, renderFlameLine(label, n.DurationMs, maxMs))
		lines = append(lines, collectFlameRows(n.Children, maxMs, depth+1)...)
	}
	return lines
}

func renderFlameLine(label string, durationMs float64, maxMs float64) string {
	w := flameWidth(durationMs, maxMs)
	return strings.Repeat(bar, w) + strings.Repeat(" ", 42-w) + " " + label + " " + fmt.Sprintf("%.1fms", durationMs)
}

func flameWidth(durationMs, maxMs float64) int {
	if maxMs <= 0 {
		return 1
	}
	return int(math.Max(1, math.Round((durationMs/maxMs)*40)))
}
