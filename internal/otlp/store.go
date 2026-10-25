package otlp

import (
	"github.com/kanchingyg/otel-pocket/internal/analyze"
)

const MaxIngestBodyBytes = 32 * 1024 * 1024

type Store struct {
	spans     []analyze.Span
	maxTraces int
}

func NewStore(maxTraces int) *Store {
	if maxTraces < 1 {
		maxTraces = 200
	}
	return &Store{maxTraces: maxTraces}
}

func (s *Store) Push(batch []analyze.Span) {
	s.spans = append(s.spans, batch...)
	ids := []string{}
	seen := map[string]bool{}
	for _, sp := range s.spans {
		if !seen[sp.TraceID] {
			seen[sp.TraceID] = true
			ids = append(ids, sp.TraceID)
		}
	}
	for len(ids) > s.maxTraces {
		drop := ids[0]
		ids = ids[1:]
		filtered := make([]analyze.Span, 0, len(s.spans))
		for _, sp := range s.spans {
			if sp.TraceID != drop {
				filtered = append(filtered, sp)
			}
		}
		s.spans = filtered
	}
}

func (s *Store) Spans() []analyze.Span {
	return s.spans
}

func (s *Store) ListSummaries() []analyze.TraceSummary {
	byTrace := analyze.GroupByTrace(s.spans)
	out := make([]analyze.TraceSummary, 0, len(byTrace))
	for _, spans := range byTrace {
		out = append(out, analyze.SummarizeTrace(spans))
	}
	sortSummaries(out)
	return out
}

func sortSummaries(s []analyze.TraceSummary) {
	for i := 0; i < len(s); i++ {
		for j := i + 1; j < len(s); j++ {
			if s[j].DurationMs > s[i].DurationMs {
				s[i], s[j] = s[j], s[i]
			}
		}
	}
}

func (s *Store) GetTrace(traceID string) []analyze.Span {
	return analyze.MatchTraceSpans(s.spans, traceID)
}
