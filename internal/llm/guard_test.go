package llm

import (
	"testing"
)

func TestBlocksNonLoopback(t *testing.T) {
	if err := AssertLoopbackBaseURL("https://api.openai.com"); err == nil {
		t.Fatal("expected non-loopback error")
	}
}
