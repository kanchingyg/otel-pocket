package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/kanchingyg/otel-pocket/internal/otlp"
)

const Version = "0.1.0"
const defaultNCtx = 4096

type Server struct {
	store *otlp.Store
	nCtx  int
}

func NewServer(store *otlp.Store, nCtx int) *Server {
	if nCtx <= 0 {
		nCtx = defaultNCtx
	}
	return &Server{store: store, nCtx: nCtx}
}

func (s *Server) Run() error {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg map[string]interface{}
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		s.dispatch(msg)
	}
	return scanner.Err()
}

func writeFrame(obj map[string]interface{}) {
	b, _ := json.Marshal(obj)
	_, _ = os.Stdout.Write(b)
	_, _ = os.Stdout.Write([]byte("\n"))
}

func (s *Server) dispatch(msg map[string]interface{}) {
	method, _ := msg["method"].(string)
	id := msg["id"]
	switch method {
	case "initialize":
		writeFrame(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      id,
			"result": map[string]interface{}{
				"protocolVersion": "2024-11-05",
				"capabilities":  map[string]interface{}{"tools": map[string]interface{}{}},
				"serverInfo":    map[string]interface{}{"name": "otel-pocket", "version": Version},
			},
		})
	case "notifications/initialized":
		return
	case "tools/list":
		writeFrame(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      id,
			"result":  map[string]interface{}{"tools": toolDefs()},
		})
	case "tools/call":
		params, _ := msg["params"].(map[string]interface{})
		name, _ := params["name"].(string)
		args, _ := params["arguments"].(map[string]interface{})
		if args == nil {
			args = map[string]interface{}{}
		}
		result, isErr := s.callTool(name, args)
		writeFrame(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      id,
			"result": map[string]interface{}{
				"content": []map[string]string{{"type": "text", "text": result}},
				"isError": isErr,
			},
		})
	default:
		if id != nil {
			writeFrame(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      id,
				"error":   map[string]interface{}{"code": -32601, "message": fmt.Sprintf("Method not found: %s", method)},
			})
		}
	}
}

func toolDefs() []map[string]interface{} {
	return []map[string]interface{}{
		{
			"name":        "list_recent_traces",
			"description": "List recent OTLP traces with duration and errors.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"minDurationMs": map[string]string{"type": "number"},
					"errorsOnly":    map[string]string{"type": "boolean"},
				},
				"additionalProperties": false,
			},
		},
		{
			"name":        "inspect_trace_tree",
			"description": "Hierarchical span tree with N+1 SQL and gen_ai metrics.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"traceId": map[string]string{"type": "string"},
					"verbose": map[string]interface{}{"type": "boolean", "description": "Include raw SQL, URLs, and HTTP headers in output"},
				},
				"required":             []string{"traceId"},
				"additionalProperties": false,
			},
		},
		{
			"name":        "diagnose_slow_trace",
			"description": "Explain trace bottlenecks via local OpenAI-compatible LLM.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"traceId": map[string]string{"type": "string"},
					"model":   map[string]string{"type": "string"},
					"baseUrl": map[string]string{"type": "string"},
				},
				"required":             []string{"traceId"},
				"additionalProperties": false,
			},
		},
	}
}
