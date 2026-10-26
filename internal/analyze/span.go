package analyze

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const MinTraceIDPrefixLen = 8

var sqlKeys = []string{"db.statement", "db.query.text", "sql.query"}

type Span struct {
	TraceID      string
	SpanID       string
	ParentSpanID string
	Name         string
	StartNs      int64
	EndNs        int64
	Attributes   map[string]string
	StatusCode   int
}

type TraceSummary struct {
	TraceID    string
	RootName   string
	DurationMs float64
	SpanCount  int
	HasError   bool
}

type N1Pattern struct {
	Statement string  `json:"statement"`
	Count     int     `json:"count"`
	TotalMs   float64 `json:"totalMs"`
}

type GenAiMetrics struct {
	Model        string   `json:"model,omitempty"`
	InputTokens  *int     `json:"inputTokens,omitempty"`
	OutputTokens *int     `json:"outputTokens,omitempty"`
	LatencyMs    float64  `json:"latencyMs"`
	TokensPerSec *float64 `json:"tokensPerSec,omitempty"`
}

type EmbeddingAlert struct {
	BatchSize  *int    `json:"batchSize,omitempty"`
	Dimension  *int    `json:"dimension,omitempty"`
	LatencyMs  float64 `json:"latencyMs"`
	Message    string  `json:"message"`
}

type TraceAnalysis struct {
	TraceID         string           `json:"traceId"`
	DurationMs      float64          `json:"durationMs"`
	N1              []N1Pattern      `json:"n1"`
	GenAi           []GenAiMetrics   `json:"genAi"`
	EmbeddingAlerts []EmbeddingAlert `json:"embeddingAlerts"`
	CriticalPathMs  float64          `json:"criticalPathMs"`
}

type TraceNode struct {
	Span       Span
	Children   []TraceNode
	DurationMs float64
}

func SpanDurationMs(s Span) float64 {
	return math.Max(0, float64(s.EndNs-s.StartNs)/1e6)
}

func AttrString(s Span, key string) string {
	return s.Attributes[key]
}

func MatchTraceSpans(spans []Span, traceID string) []Span {
	id := strings.TrimSpace(traceID)
	if id == "" {
		return nil
	}
	var exact []Span
	for _, s := range spans {
		if s.TraceID == id {
			exact = append(exact, s)
		}
	}
	if len(exact) > 0 {
		return exact
	}
	if len(id) < MinTraceIDPrefixLen {
		return nil
	}
	var prefixed []Span
	ids := map[string]struct{}{}
	for _, s := range spans {
		if strings.HasPrefix(s.TraceID, id) {
			prefixed = append(prefixed, s)
			ids[s.TraceID] = struct{}{}
		}
	}
	if len(ids) == 1 {
		return prefixed
	}
	return nil
}

func ParseOtlpJSON(body []byte) ([]Span, error) {
	var root map[string]interface{}
	if err := json.Unmarshal(body, &root); err != nil {
		return nil, err
	}
	var out []Span
	resourceSpans, _ := root["resourceSpans"].([]interface{})
	for _, rs := range resourceSpans {
		rsMap, _ := rs.(map[string]interface{})
		scopeSpans, _ := rsMap["scopeSpans"].([]interface{})
		for _, ss := range scopeSpans {
			ssMap, _ := ss.(map[string]interface{})
			spans, _ := ssMap["spans"].([]interface{})
			for _, raw := range spans {
				s, _ := raw.(map[string]interface{})
				attrs := map[string]string{}
				attrList, _ := s["attributes"].([]interface{})
				for _, a := range attrList {
					am, _ := a.(map[string]interface{})
					key, _ := am["key"].(string)
					vm, _ := am["value"].(map[string]interface{})
					if sv, ok := vm["stringValue"].(string); ok {
						attrs[key] = sv
					} else if iv, ok := vm["intValue"]; ok {
						attrs[key] = stringifyNum(iv)
					} else if bv, ok := vm["boolValue"].(bool); ok {
						if bv {
							attrs[key] = "true"
						} else {
							attrs[key] = "false"
						}
					}
				}
				parent := ""
				if p, ok := s["parentSpanId"]; ok {
					parent = hexID(p)
				}
				statusCode := 0
				if st, ok := s["status"].(map[string]interface{}); ok {
					if c, ok := st["code"].(float64); ok {
						statusCode = int(c)
					}
				}
				out = append(out, Span{
					TraceID:      hexID(s["traceId"]),
					SpanID:       hexID(s["spanId"]),
					ParentSpanID: parent,
					Name:         stringOr(s["name"], "span"),
					StartNs:      parseNano(s["startTimeUnixNano"]),
					EndNs:        parseNano(s["endTimeUnixNano"]),
					Attributes:   attrs,
					StatusCode:   statusCode,
				})
			}
		}
	}
	return out, nil
}

func hexID(v interface{}) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatInt(int64(x), 10)
	default:
		return ""
	}
}

func stringOr(v interface{}, def string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return def
}

func parseNano(v interface{}) int64 {
	switch x := v.(type) {
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	case float64:
		return int64(x)
	default:
		return 0
	}
}

func stringifyNum(v interface{}) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatInt(int64(x), 10)
	default:
		return ""
	}
}

func GroupByTrace(spans []Span) map[string][]Span {
	m := map[string][]Span{}
	for _, s := range spans {
		m[s.TraceID] = append(m[s.TraceID], s)
	}
	return m
}

func SummarizeTrace(spans []Span) TraceSummary {
	if len(spans) == 0 {
		return TraceSummary{}
	}
	root := spans[0]
	for _, s := range spans {
		if s.ParentSpanID == "" {
			root = s
			break
		}
	}
	minStart := spans[0].StartNs
	maxEnd := spans[0].EndNs
	for _, s := range spans {
		if s.StartNs < minStart {
			minStart = s.StartNs
		}
		if s.EndNs > maxEnd {
			maxEnd = s.EndNs
		}
	}
	hasError := false
	for _, s := range spans {
		if s.StatusCode == 2 {
			hasError = true
			break
		}
	}
	return TraceSummary{
		TraceID:    root.TraceID,
		RootName:   root.Name,
		DurationMs: float64(maxEnd-minStart) / 1e6,
		SpanCount:  len(spans),
		HasError:   hasError,
	}
}

func DetectN1(spans []Span, minCount int) []N1Pattern {
	if minCount < 1 {
		minCount = 3
	}
	buckets := map[string]*struct {
		count   int
		totalMs float64
	}{}
	for _, s := range spans {
		stmt := sqlStatement(s)
		if stmt == "" {
			continue
		}
		norm := normalizeSQL(stmt)
		b, ok := buckets[norm]
		if !ok {
			b = &struct {
				count   int
				totalMs float64
			}{}
			buckets[norm] = b
		}
		b.count++
		b.totalMs += SpanDurationMs(s)
	}
	var out []N1Pattern
	for stmt, b := range buckets {
		if b.count >= minCount {
			out = append(out, N1Pattern{Statement: stmt, Count: b.count, TotalMs: b.totalMs})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	return out
}

func sqlStatement(s Span) string {
	for _, k := range sqlKeys {
		if v := AttrString(s, k); v != "" {
			return v
		}
	}
	return ""
}

var spaceRe = regexp.MustCompile(`\s+`)

func normalizeSQL(stmt string) string {
	return strings.TrimSpace(spaceRe.ReplaceAllString(stmt, " "))
}

func ExtractGenAi(spans []Span) []GenAiMetrics {
	var out []GenAiMetrics
	for _, s := range spans {
		kind := AttrString(s, "gen_ai.operation.name")
		if kind == "" {
			kind = s.Name
		}
		if !strings.Contains(kind, "gen_ai") && !strings.Contains(kind, "chat") && AttrString(s, "gen_ai.request.model") == "" {
			continue
		}
		latency := SpanDurationMs(s)
		inTok := numAttr(s, "gen_ai.usage.input_tokens")
		if inTok == nil {
			inTok = numAttr(s, "gen_ai.usage.prompt_tokens")
		}
		outTok := numAttr(s, "gen_ai.usage.output_tokens")
		if outTok == nil {
			outTok = numAttr(s, "gen_ai.usage.completion_tokens")
		}
		total := 0
		if inTok != nil {
			total += *inTok
		}
		if outTok != nil {
			total += *outTok
		}
		var tps *float64
		if total > 0 && latency > 0 {
			v := (float64(total) / latency) * 1000
			tps = &v
		}
		model := AttrString(s, "gen_ai.request.model")
		if model == "" {
			model = AttrString(s, "gen_ai.response.model")
		}
		out = append(out, GenAiMetrics{
			Model:        model,
			InputTokens:  inTok,
			OutputTokens: outTok,
			LatencyMs:    latency,
			TokensPerSec: tps,
		})
	}
	return out
}

var allowedDims = map[int]bool{384: true, 768: true, 1024: true, 1536: true, 2560: true, 3072: true, 4096: true}

func AuditEmbeddings(spans []Span) []EmbeddingAlert {
	var alerts []EmbeddingAlert
	for _, s := range spans {
		op := AttrString(s, "gen_ai.operation.name")
		if op == "" {
			op = s.Name
		}
		if !strings.Contains(op, "embed") {
			continue
		}
		batch := numAttr(s, "gen_ai.embeddings.batch_size")
		dim := numAttr(s, "gen_ai.embeddings.dimension")
		latency := SpanDurationMs(s)
		if batch != nil && *batch > 10 {
			alerts = append(alerts, EmbeddingAlert{
				BatchSize: batch, Dimension: dim, LatencyMs: latency,
				Message: "Embedding batch " + strconv.Itoa(*batch) + " exceeds safe threshold (>10)",
			})
		}
		if batch != nil && *batch > 32 {
			alerts = append(alerts, EmbeddingAlert{
				BatchSize: batch, Dimension: dim, LatencyMs: latency,
				Message: "Embedding batch " + strconv.Itoa(*batch) + " may exceed TEI/Qdrant limits (>32)",
			})
		}
		if dim != nil && !allowedDims[*dim] {
			alerts = append(alerts, EmbeddingAlert{
				BatchSize: batch, Dimension: dim, LatencyMs: latency,
				Message: "Unusual embedding dimension " + strconv.Itoa(*dim) + " — verify vector store lockfile",
			})
		}
	}
	return alerts
}

func numAttr(s Span, key string) *int {
	v, ok := s.Attributes[key]
	if !ok {
		return nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return nil
	}
	return &n
}

func AnalyzeTrace(spans []Span) TraceAnalysis {
	if len(spans) == 0 {
		return TraceAnalysis{}
	}
	minStart := spans[0].StartNs
	maxEnd := spans[0].EndNs
	for _, s := range spans {
		if s.StartNs < minStart {
			minStart = s.StartNs
		}
		if s.EndNs > maxEnd {
			maxEnd = s.EndNs
		}
	}
	tree := BuildTraceTree(spans)
	return TraceAnalysis{
		TraceID:         spans[0].TraceID,
		DurationMs:      float64(maxEnd-minStart) / 1e6,
		N1:              DetectN1(spans, 3),
		GenAi:           ExtractGenAi(spans),
		EmbeddingAlerts: AuditEmbeddings(spans),
		CriticalPathMs:  criticalPathMs(tree),
	}
}

func BuildTraceTree(spans []Span) []TraceNode {
	byID := map[string]Span{}
	for _, s := range spans {
		byID[s.SpanID] = s
	}
	children := map[string][]Span{}
	for _, s := range spans {
		pid := s.ParentSpanID
		children[pid] = append(children[pid], s)
	}
	var build func(Span) TraceNode
	build = func(s Span) TraceNode {
		kids := children[s.SpanID]
		sort.Slice(kids, func(i, j int) bool { return kids[i].StartNs < kids[j].StartNs })
		var cn []TraceNode
		for _, c := range kids {
			cn = append(cn, build(c))
		}
		return TraceNode{Span: s, DurationMs: SpanDurationMs(s), Children: cn}
	}
	var roots []Span
	for _, s := range spans {
		if s.ParentSpanID == "" {
			roots = append(roots, s)
			continue
		}
		if _, ok := byID[s.ParentSpanID]; !ok {
			roots = append(roots, s)
		}
	}
	if len(roots) == 0 && len(spans) > 0 {
		roots = []Span{spans[0]}
	}
	var nodes []TraceNode
	for _, r := range roots {
		nodes = append(nodes, build(r))
	}
	return nodes
}

func criticalPathMs(nodes []TraceNode) float64 {
	var best float64
	for _, n := range nodes {
		childMax := 0.0
		if len(n.Children) > 0 {
			childMax = criticalPathMs(n.Children)
		}
		best = math.Max(best, n.DurationMs+childMax)
	}
	return best
}

func CollapseN1Lines(spans []Span) []string {
	n1 := DetectN1(spans, 3)
	collapsed := map[string]bool{}
	for _, p := range n1 {
		collapsed[p.Statement] = true
	}
	seen := map[string]bool{}
	var lines []string
	for _, s := range spans {
		stmt := sqlStatement(s)
		norm := ""
		if stmt != "" {
			norm = normalizeSQL(stmt)
		}
		if norm != "" && collapsed[norm] {
			if !seen[norm] {
				for _, p := range n1 {
					if p.Statement == norm {
						preview := p.Statement
						if len(preview) > 80 {
							preview = preview[:80]
						}
						lines = append(lines, strconv.Itoa(p.Count)+"x "+preview+" [total "+strconv.Itoa(int(math.Round(p.TotalMs)))+"ms]")
						break
					}
				}
				seen[norm] = true
			}
			continue
		}
		lines = append(lines, s.Name+" ("+strconv.Itoa(int(math.Round(SpanDurationMs(s))))+"ms)")
	}
	return lines
}

func FormatTraceTreeText(nodes []TraceNode, indent int) string {
	pad := strings.Repeat("  ", indent)
	var parts []string
	for _, n := range nodes {
		head := pad + n.Span.Name + " " + strconv.Itoa(int(math.Round(n.DurationMs))) + "ms"
		child := FormatTraceTreeText(n.Children, indent+1)
		if child != "" {
			parts = append(parts, head+"\n"+child)
		} else {
			parts = append(parts, head)
		}
	}
	return strings.Join(parts, "\n")
}

func FilterTraces(summaries []TraceSummary, minDurationMs *float64, errorsOnly bool) []TraceSummary {
	var out []TraceSummary
	for _, t := range summaries {
		if errorsOnly && !t.HasError {
			continue
		}
		if minDurationMs != nil && t.DurationMs < *minDurationMs {
			continue
		}
		out = append(out, t)
	}
	return out
}

func TruncateForModel(text string, nCtx int) string {
	max := int(math.Floor(float64(nCtx) * 4 * 0.45))
	if len(text) <= max {
		return text
	}
	marker := "[...TRUNCATED BY OTEL-POCKET...]"
	head := int(math.Floor(float64(max) * 0.6))
	tail := max - head - len(marker)
	if tail < 0 {
		tail = 0
	}
	if len(text) < tail {
		tail = len(text)
	}
	return text[:head] + marker + text[len(text)-tail:]
}
