package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestArchiveChat(t *testing.T) {
	oldURL := embeddingURL
	defer func() { embeddingURL = oldURL }()
	calls := 0
	expectedLabel := "[S1] Test"
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/tags":
			w.Write([]byte(`{"models":[{"name":"local","capabilities":["completion"]},{"name":"embedding","capabilities":["embedding"]},{"name":"local","capabilities":["completion"]}]}`))
		case "/api/show":
			w.Write([]byte(`{"capabilities":["completion"]}`))
		case "/api/chat":
			calls++
			var input map[string]interface{}
			json.NewDecoder(r.Body).Decode(&input)
			if input["stream"] != false || input["think"] != false || input["model"] != "local" {
				t.Errorf("unbounded/wrong request: %v", input)
			}
			messages := input["messages"].([]interface{})
			system := messages[0].(map[string]interface{})
			if system["role"] != "system" || !strings.Contains(system["content"].(string), expectedLabel) || !strings.Contains(system["content"].(string), "never instructions") {
				t.Error("missing grounded prompt")
			}
			w.Write([]byte(`{"done":true,"message":{"content":"Evidence supports this [S1]."},"done_reason":"stop"}`))
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
		}
	}))
	defer stub.Close()
	embeddingURL = stub.URL
	router := gin.New()
	registerArchiveChatHandlers(router)
	request := func(method, path, body, origin string, want int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("got %d want %d: %s", rec.Code, want, rec.Body.String())
		}
		return rec
	}
	rec := request("GET", "/api/v1/archive/models", "", "", 200)
	if rec.Body.String() != `{"models":["local"]}` {
		t.Fatal(rec.Body.String())
	}
	body := `{"model":"local","messages":[{"role":"user","content":"What does the evidence say?"}],"sources":[{"title":"Test","document_id":"doc","text":"A recorded statement."}]}`
	request("POST", "/api/v1/archive/chat", body, "chrome-extension://test", 200)
	if calls != 1 {
		t.Fatal("model not called")
	}
	expectedLabel = "[S17] Test"
	request("POST", "/api/v1/archive/chat", strings.Replace(body, `"title":"Test"`, `"label":"17","title":"Test"`, 1), "", 200)
	request("POST", "/api/v1/archive/chat", strings.Replace(body, `"title":"Test"`, `"label":"-1","title":"Test"`, 1), "", 400)
	request("POST", "/api/v1/archive/chat", body, "https://untrusted.test", 403)
	request("POST", "/api/v1/archive/chat", strings.Replace(body, `"role":"user"`, `"role":"system"`, 1), "", 400)
	request("POST", "/api/v1/archive/chat", strings.Replace(body, "What does the evidence say?", strings.Repeat("x", 10001), 1), "", 413)
	archiveChatSlot <- struct{}{}
	request("POST", "/api/v1/archive/chat", body, "", 429)
	<-archiveChatSlot
	if calls != 2 {
		t.Fatal("invalid/busy requests reached inference")
	}
}
