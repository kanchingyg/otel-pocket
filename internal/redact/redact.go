package redact

import (
	"os"
	"regexp"
	"strings"

	"github.com/kanchingyg/otel-pocket/internal/analyze"
)

const Redacted = "[REDACTED]"

var sensitivePrefix = regexp.MustCompile(`^(?i)(db\.statement|db\.query\.text|sql\.query|url\.full|http\.(request|response)\.header\.)`)

func IsSensitiveSpanAttributeKey(key string) bool {
	if sensitivePrefix.MatchString(key) {
		return true
	}
	return strings.Contains(strings.ToLower(key), "authorization")
}

func RedactSecretsInString(text string) string {
	out := text
	replacers := []struct {
		re  *regexp.Regexp
		rep string
	}{
		{regexp.MustCompile(`(?i)(api[_-]?key|authorization|bearer|token|password|secret)\s*[:=]\s*\S+`), "[REDACTED]"},
		{regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._-]+`), "Bearer [REDACTED]"},
		{regexp.MustCompile(`sk-[A-Za-z0-9]{20,}`), "[REDACTED]"},
	}
	for _, r := range replacers {
		out = r.re.ReplaceAllString(out, r.rep)
	}
	return out
}

func RedactN1Pattern(p analyze.N1Pattern, verbose bool) analyze.N1Pattern {
	if verbose {
		return p
	}
	p.Statement = Redacted
	return p
}

func RedactCollapsedLine(line string, verbose bool) string {
	if verbose {
		return line
	}
	re := regexp.MustCompile(`^(\d+x\s+).+(\s+\[total\s+\d+ms\])$`)
	if m := re.FindStringSubmatch(line); len(m) == 3 {
		return m[1] + Redacted + m[2]
	}
	return RedactSecretsInString(line)
}

func RedactTreeText(tree string, spans []analyze.Span, verbose bool) string {
	if verbose {
		return tree
	}
	out := tree
	for _, span := range spans {
		for key, value := range span.Attributes {
			if IsSensitiveSpanAttributeKey(key) || strings.Contains(strings.ToLower(value), "http://") || strings.Contains(strings.ToLower(value), "https://") {
				out = strings.ReplaceAll(out, value, Redacted)
			}
		}
	}
	return RedactSecretsInString(out)
}

type InspectTraceResult struct {
	TraceID         string                 `json:"traceId"`
	DurationMs      float64                `json:"durationMs"`
	CriticalPathMs  float64                `json:"criticalPathMs"`
	N1              []analyze.N1Pattern    `json:"n1"`
	GenAi           []analyze.GenAiMetrics `json:"genAi"`
	EmbeddingAlerts []analyze.EmbeddingAlert `json:"embeddingAlerts"`
	Tree            string                 `json:"tree"`
	Collapsed       []string               `json:"collapsed"`
}

func SanitizeInspectTraceResult(result InspectTraceResult, spans []analyze.Span, verbose bool) InspectTraceResult {
	if verbose {
		return result
	}
	for i, p := range result.N1 {
		result.N1[i] = RedactN1Pattern(p, verbose)
	}
	for i, line := range result.Collapsed {
		result.Collapsed[i] = RedactCollapsedLine(line, verbose)
	}
	result.Tree = RedactTreeText(result.Tree, spans, verbose)
	return result
}

func InspectVerboseFromEnv(verboseArg bool) bool {
	if verboseArg {
		return true
	}
	return os.Getenv("OTEL_POCKET_VERBOSE_MCP") == "1"
}
