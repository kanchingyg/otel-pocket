package llm

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

func IsLoopbackHost(hostname string) bool {
	host := strings.Trim(hostname, "[]")
	host = strings.ToLower(host)
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func AssertLoopbackBaseURL(baseURL string) error {
	if os.Getenv("OTEL_POCKET_ALLOW_REMOTE_LLM") == "1" {
		return nil
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return fmt.Errorf("Invalid LLM baseUrl: %s", baseURL)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("LLM baseUrl must be http(s): %s", baseURL)
	}
	if !IsLoopbackHost(u.Hostname()) {
		return fmt.Errorf("Non-loopback LLM baseUrl blocked (%s). Set OTEL_POCKET_ALLOW_REMOTE_LLM=1 to allow.", u.Hostname())
	}
	return nil
}
