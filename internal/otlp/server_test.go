package otlp

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

func TestRejectOversizeBody(t *testing.T) {
	store := NewStore(5)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	srv := NewServer(port, store, 512)
	go func() { _ = srv.ListenAndServe() }()
	defer srv.Close()

	body := strings.Repeat("x", 513)
	res, err := http.Post("http://127.0.0.1:"+strconv.Itoa(port)+"/v1/traces", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", res.StatusCode)
	}
	if MaxIngestBodyBytes != 32*1024*1024 {
		t.Fatalf("unexpected default cap")
	}
}
