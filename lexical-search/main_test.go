package main

import (
	"github.com/gin-gonic/gin"
	"lexical-search/config"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestSettingsAPI(t *testing.T) {
	gin.SetMode(gin.TestMode)
	path := filepath.Join(t.TempDir(), "config.json")
	router := gin.New()
	registerConfigHandlers(router, path, 8766)
	request := func(method, body, origin, contentType string, expected int) string {
		t.Helper()
		req := httptest.NewRequest(method, "/api/v1/config", strings.NewReader(body))
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", contentType)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != expected {
			t.Fatalf("status %d: %s", res.Code, res.Body.String())
		}
		return res.Body.String()
	}
	body := `{"port":9876,"archive_root":"~/custom-archive"}`
	request("PUT", body, "https://evil.example", "application/json", 403)
	request("PUT", body, "", "text/plain", 415)
	request("PUT", strings.Repeat(" ", 4097), "", "application/json", 400)
	request("PUT", `{"port":-1}`, "", "application/json", 400)
	request("PUT", body, "chrome-extension://test", "application/json", 200)
	port, root, _, _, err := config.Read(path)
	if err != nil || port != 9876 || root != "~/custom-archive" {
		t.Fatal("config not persisted", port, root, err)
	}
	result := request("GET", "", "", "", 200)
	if !strings.Contains(result, `"active_port":8766`) || !strings.Contains(result, `"port":9876`) || strings.Contains(result, "runtime-key") {
		t.Fatal(result)
	}
}
