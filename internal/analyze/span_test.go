package analyze

import (
	"encoding/json"
	"fmt"
	"testing"
)

func buildFixtureSpans(traceID, sql string) []interface{} {
	root := map[string]interface{}{
		"traceId": traceID, "spanId": "root1", "name": "HTTP GET /api/items",
		"startTimeUnixNano": "1000000000", "endTimeUnixNano": "2800000000",
		"attributes": []interface{}{},
	}
	var spans []interface{}
	spans = append(spans, root)
	for i := 0; i < 8; i++ {
		spans = append(spans, map[string]interface{}{
			"traceId": traceID, "spanId": fmt.Sprintf("sql%d", i), "parentSpanId": "root1",
			"name": "db.query",
			"startTimeUnixNano": fmt.Sprintf("%d", 1100000000+i*100000000),
			"endTimeUnixNano":   fmt.Sprintf("%d", 1150000000+i*100000000),
			"attributes": []interface{}{
				map[string]interface{}{"key": "db.statement", "value": map[string]interface{}{"stringValue": sql}},
			},
		})
	}
	spans = append(spans, map[string]interface{}{
		"traceId": traceID, "spanId": "genai1", "parentSpanId": "root1", "name": "gen_ai.chat",
		"startTimeUnixNano": "2000000000", "endTimeUnixNano": "2500000000",
		"attributes": []interface{}{
			map[string]interface{}{"key": "gen_ai.request.model", "value": map[string]interface{}{"stringValue": "llama3.2"}},
			map[string]interface{}{"key": "gen_ai.usage.input_tokens", "value": map[string]interface{}{"intValue": "120"}},
			map[string]interface{}{"key": "gen_ai.usage.output_tokens", "value": map[string]interface{}{"intValue": "40"}},
		},
	})
	return spans
}

func fixturePayload(traceID string) []byte {
	sql := "SELECT * FROM items WHERE id = ?"
	payload := map[string]interface{}{
		"resourceSpans": []interface{}{
			map[string]interface{}{
				"scopeSpans": []interface{}{
					map[string]interface{}{"spans": buildFixtureSpans(traceID, sql)},
				},
			},
		},
	}
	b, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	return b
}

func TestDetectN1FromFixture(t *testing.T) {
	spans, err := ParseOtlpJSON(fixturePayload("abc123trace"))
	if err != nil {
		t.Fatal(err)
	}
	if len(spans) != 10 {
		t.Fatalf("expected 10 spans, got %d", len(spans))
	}
	n1 := DetectN1(spans, 3)
	if len(n1) == 0 || n1[0].Count != 8 {
		t.Fatalf("expected N+1 count 8, got %+v", n1)
	}
	analysis := AnalyzeTrace(spans)
	if len(analysis.GenAi) == 0 || analysis.GenAi[0].TokensPerSec == nil || *analysis.GenAi[0].TokensPerSec <= 0 {
		t.Fatalf("expected tokens/sec > 0, got %+v", analysis.GenAi)
	}
}

func TestMatchTracePrefix(t *testing.T) {
	spans, err := ParseOtlpJSON(fixturePayload("abcdef1234567890"))
	if err != nil {
		t.Fatal(err)
	}
	if len(MatchTraceSpans(spans, "abc")) != 0 {
		t.Fatal("short prefix should not match")
	}
	if len(MatchTraceSpans(spans, "abcdef12")) == 0 {
		t.Fatal("expected prefix match")
	}
}
