package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Deliberately fixed to the local test runtime, not an arbitrary remote URL.
var embeddingURL = "http://127.0.0.1:11435" // Variable only to isolate HTTP tests.

var errEmbeddingInput = errors.New("Ollama rejected input")

func ollamaJSON(ctx context.Context, path string, input, output interface{}) error {
	var body io.Reader
	method := http.MethodGet
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body, method = bytes.NewReader(data), http.MethodPost
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, embeddingURL+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusBadRequest {
		return fmt.Errorf("%w: %s", errEmbeddingInput, path)
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Ollama %s: HTTP %d", path, response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(output)
}
