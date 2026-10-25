package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kanchingyg/otel-pocket/internal/mcp"
	"github.com/kanchingyg/otel-pocket/internal/otlp"
	"github.com/kanchingyg/otel-pocket/internal/tui"
)

const defaultPort = 4318

func main() {
	port := defaultPort
	mcpMode := false
	help := false
	flag.IntVar(&port, "port", defaultPort, "OTLP HTTP port")
	flag.BoolVar(&mcpMode, "mcp", false, "Run MCP server on stdio")
	flag.BoolVar(&help, "help", false, "Show help")
	flag.BoolVar(&help, "h", false, "Show help")
	flag.Parse()
	if help {
		_, _ = fmt.Fprint(os.Stderr, "otel-pocket — local OTLP :4318 collector with TUI + MCP\n\n"+
			"  otel-pocket [--port 4318]\n"+
			"  otel-pocket --mcp\n")
		os.Exit(0)
	}

	store := otlp.NewStore(200)
	srv := otlp.NewServer(port, store, otlp.MaxIngestBodyBytes)
	go func() {
		if err := srv.ListenAndServe(); err != nil && err.Error() != "http: Server closed" {
			fmt.Fprintf(os.Stderr, "server error: %v\n", err)
		}
	}()

	if mcpMode {
		if err := mcp.NewServer(store, 4096).Run(); err != nil {
			fmt.Fprintf(os.Stderr, "mcp error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	fmt.Fprintf(os.Stderr, "otel-pocket listening on http://127.0.0.1:%d/v1/traces\n", port)
	tick := func() {
		last := store.Spans()
		if len(last) > 80 {
			last = last[len(last)-80:]
		}
		_, _ = fmt.Fprint(os.Stderr, "\x1b[2J\x1b[H"+tui.RenderLiveFrame(last, port)+"\n")
	}
	tick()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	ticker := time.NewTicker(2 * time.Second)
	for {
		select {
		case <-ticker.C:
			tick()
		case <-sig:
			_ = srv.Close()
			return
		}
	}
}
