package otlp

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"

	"github.com/kanchingyg/otel-pocket/internal/analyze"
)

type Server struct {
	Addr   string
	Store  *Store
	MaxBody int
	srv    *http.Server
}

func NewServer(port int, store *Store, maxBody int) *Server {
	if maxBody <= 0 {
		maxBody = MaxIngestBodyBytes
	}
	s := &Server{
		Addr:    fmt.Sprintf("127.0.0.1:%d", port),
		Store:   store,
		MaxBody: maxBody,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/v1/traces", s.handleTraces)
	s.srv = &http.Server{Handler: mux}
	return s
}

func (s *Server) ListenAndServe() error {
	ln, err := net.Listen("tcp", s.Addr)
	if err != nil {
		return err
	}
	return s.srv.Serve(ln)
}

func (s *Server) Close() error {
	if s.srv != nil {
		return s.srv.Close()
	}
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (s *Server) handleTraces(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	body, err := readBodyLimited(r.Body, s.MaxBody)
	if err != nil {
		http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
		return
	}
	ctype := r.Header.Get("Content-Type")
	var spans []analyze.Span
	if strings.Contains(ctype, "json") || (len(body) > 0 && body[0] == '{') {
		spans, err = analyze.ParseOtlpJSON(body)
	} else {
		spans, err = decodeProtobufStub(body)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.Store.Push(spans)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"partialSuccess": map[string]interface{}{},
		"spans":          len(spans),
	})
}

func readBodyLimited(r io.Reader, max int) ([]byte, error) {
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	total := 0
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			total += n
			if total > max {
				return nil, fmt.Errorf("payload exceeds %d bytes", max)
			}
			buf = append(buf, tmp[:n]...)
		}
		if err == io.EOF {
			return buf, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

func decodeProtobufStub(buf []byte) ([]analyze.Span, error) {
	text := string(buf)
	if len(text) == 0 {
		return nil, fmt.Errorf("empty protobuf payload")
	}
	traceID := "pb" + fmt.Sprintf("%x", buf[:min(8, len(buf))])
	var spans []analyze.Span
	i := 0
	for _, nm := range extractPrintable(text) {
		if !strings.Contains(nm, "SELECT") && !strings.Contains(nm, "HTTP") && !strings.Contains(nm, "gen_ai") {
			continue
		}
		attrs := map[string]string{}
		if strings.Contains(nm, "SELECT") {
			attrs["db.statement"] = nm
		}
		spans = append(spans, analyze.Span{
			TraceID: traceID, SpanID: fmt.Sprintf("s%d", i), Name: nm,
			StartNs: 0, EndNs: 1e6, Attributes: attrs,
		})
		i++
	}
	if len(spans) == 0 {
		return nil, fmt.Errorf("empty protobuf payload")
	}
	return spans, nil
}

func extractPrintable(text string) []string {
	var out []string
	cur := ""
	for _, r := range text {
		if r >= 0x20 && r <= 0x7e {
			cur += string(r)
		} else if len(cur) >= 2 {
			if len(cur) <= 64 {
				out = append(out, cur)
			}
			cur = ""
		} else {
			cur = ""
		}
	}
	if len(cur) >= 2 && len(cur) <= 64 {
		out = append(out, cur)
	}
	return out
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
