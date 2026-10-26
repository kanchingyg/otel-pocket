package llm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/kanchingyg/otel-pocket/internal/redact"
)

type DiagnoseResult struct {
	Diagnosis string `json:"diagnosis"`
	Model     string `json:"model"`
}

func DiagnoseWithOpenAICompat(baseURL, model, prompt string) (DiagnoseResult, error) {
	if err := AssertLoopbackBaseURL(baseURL); err != nil {
		return DiagnoseResult{}, err
	}
	safePrompt := redact.RedactSecretsInString(prompt)
	body := map[string]interface{}{
		"model":    model,
		"messages": []map[string]string{{"role": "user", "content": safePrompt}},
	}
	payload, _ := json.Marshal(body)
	endpoint := strings.TrimRight(baseURL, "/") + "/v1/chat/completions"
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return DiagnoseResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 120 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return DiagnoseResult{}, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 400 {
		return DiagnoseResult{Diagnosis: fmt.Sprintf("LLM error %d: %s", res.StatusCode, string(raw)), Model: model}, nil
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return DiagnoseResult{}, err
	}
	msg := ""
	if len(parsed.Choices) > 0 {
		msg = parsed.Choices[0].Message.Content
		if msg == "" {
			msg = parsed.Choices[0].Message.ReasoningContent
		}
	}
	if msg == "" {
		msg = "No LLM content"
	}
	return DiagnoseResult{Diagnosis: redact.RedactSecretsInString(msg), Model: model}, nil
}
