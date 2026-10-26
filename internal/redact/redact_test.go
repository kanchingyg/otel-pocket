package redact

import (
	"strings"
	"testing"

	"github.com/kanchingyg/otel-pocket/internal/analyze"
)

func TestVerboseInspectShowsSQL(t *testing.T) {
	stmt := "SELECT * FROM items WHERE id = ?"
	spans := []analyze.Span{{Attributes: map[string]string{"db.statement": stmt}}}
	verbose := SanitizeInspectTraceResult(InspectTraceResult{
		TraceID: "t1",
		N1:      []analyze.N1Pattern{{Statement: stmt, Count: 8, TotalMs: 40}},
		Collapsed: []string{"8x SELECT * FROM items [total 40ms]"},
		Tree:      "HTTP GET",
	}, spans, true)
	redacted := SanitizeInspectTraceResult(InspectTraceResult{
		TraceID: "t1",
		N1:      []analyze.N1Pattern{{Statement: stmt, Count: 8, TotalMs: 40}},
		Collapsed: []string{"8x SELECT * FROM items [total 40ms]"},
		Tree:      "HTTP GET",
	}, spans, false)
	if redacted.N1[0].Statement != Redacted {
		t.Fatalf("expected redacted statement")
	}
	if !strings.Contains(verbose.N1[0].Statement, "SELECT") {
		t.Fatalf("verbose should expose SQL")
	}
}
