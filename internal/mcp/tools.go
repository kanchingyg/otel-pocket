package mcp

import (
	"encoding/json"
	"fmt"
	"math"
	"os"

	"github.com/kanchingyg/otel-pocket/internal/analyze"
	"github.com/kanchingyg/otel-pocket/internal/llm"
	"github.com/kanchingyg/otel-pocket/internal/redact"
)

func (s *Server) callTool(name string, args map[string]interface{}) (string, bool) {
	switch name {
	case "list_recent_traces":
		return s.toolListRecent(args)
	case "inspect_trace_tree":
		return s.toolInspect(args)
	case "diagnose_slow_trace":
		return s.toolDiagnose(args)
	default:
		return fmt.Sprintf("unknown tool %s", name), true
	}
}

func (s *Server) toolListRecent(args map[string]interface{}) (string, bool) {
	var minDur *float64
	if v, ok := args["minDurationMs"].(float64); ok {
		minDur = &v
	}
	errorsOnly := false
	if v, ok := args["errorsOnly"].(bool); ok {
		errorsOnly = v
	}
	list := analyze.FilterTraces(s.store.ListSummaries(), minDur, errorsOnly)
	if len(list) > 50 {
		list = list[:50]
	}
	type row struct {
		TraceID    string  `json:"traceId"`
		Root       string  `json:"root"`
		DurationMs int     `json:"durationMs"`
		Spans      int     `json:"spans"`
		Error      bool    `json:"error"`
	}
	out := make([]row, 0, len(list))
	for _, t := range list {
		out = append(out, row{
			TraceID: t.TraceID, Root: t.RootName,
			DurationMs: int(math.Round(t.DurationMs)), Spans: t.SpanCount, Error: t.HasError,
		})
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	return string(b), false
}

func (s *Server) toolInspect(args map[string]interface{}) (string, bool) {
	traceID, _ := args["traceId"].(string)
	verbose := redact.InspectVerboseFromEnv(args["verbose"] == true)
	spans := s.store.GetTrace(traceID)
	if len(spans) == 0 {
		b, _ := json.Marshal(map[string]string{"error": "trace not found"})
		return string(b), false
	}
	analysis := analyze.AnalyzeTrace(spans)
	raw := redact.InspectTraceResult{
		TraceID:         analysis.TraceID,
		DurationMs:      analysis.DurationMs,
		CriticalPathMs:  analysis.CriticalPathMs,
		N1:              analysis.N1,
		GenAi:           analysis.GenAi,
		EmbeddingAlerts: analysis.EmbeddingAlerts,
		Tree:            analyze.FormatTraceTreeText(analyze.BuildTraceTree(spans), 0),
		Collapsed:       analyze.CollapseN1Lines(spans),
	}
	sanitized := redact.SanitizeInspectTraceResult(raw, spans, verbose)
	b, _ := json.MarshalIndent(sanitized, "", "  ")
	return string(b), false
}

func (s *Server) toolDiagnose(args map[string]interface{}) (string, bool) {
	traceID, _ := args["traceId"].(string)
	spans := s.store.GetTrace(traceID)
	if len(spans) == 0 {
		b, _ := json.Marshal(map[string]string{"error": "trace not found"})
		return string(b), false
	}
	analysis := analyze.AnalyzeTrace(spans)
	raw := redact.InspectTraceResult{
		TraceID:         analysis.TraceID,
		DurationMs:      analysis.DurationMs,
		CriticalPathMs:  analysis.CriticalPathMs,
		N1:              analysis.N1,
		GenAi:           analysis.GenAi,
		EmbeddingAlerts: analysis.EmbeddingAlerts,
		Tree:            analyze.FormatTraceTreeText(analyze.BuildTraceTree(spans), 0),
		Collapsed:       analyze.CollapseN1Lines(spans),
	}
	sanitized := redact.SanitizeInspectTraceResult(raw, spans, false)
	summary := analyze.TruncateForModel(mustJSON(map[string]interface{}{
		"analysis":   sanitized,
		"collapsed": sanitized.Collapsed,
	}), s.nCtx)
	baseURL := "http://127.0.0.1:11434"
	if v, ok := args["baseUrl"].(string); ok && v != "" {
		baseURL = v
	} else if env := os.Getenv("OTEL_POCKET_LLM_URL"); env != "" {
		baseURL = env
	}
	model := "llama3.2"
	if v, ok := args["model"].(string); ok && v != "" {
		model = v
	} else if env := os.Getenv("OTEL_POCKET_LLM_MODEL"); env != "" {
		model = env
	}
	if err := llm.AssertLoopbackBaseURL(baseURL); err != nil {
		b, _ := json.Marshal(map[string]string{"error": err.Error()})
		return string(b), false
	}
	prompt := redact.RedactSecretsInString("Diagnose the slow trace.\n\n" + summary + "\n\nASSISTANT:")
	res, err := llm.DiagnoseWithOpenAICompat(baseURL, model, prompt)
	if err != nil {
		b, _ := json.Marshal(map[string]string{"error": err.Error()})
		return string(b), false
	}
	b, _ := json.MarshalIndent(res, "", "  ")
	return string(b), false
}

func mustJSON(v interface{}) string {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return "{}"
	}
	return string(b)
}
