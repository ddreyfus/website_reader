package routes

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"lexical-search/config"
	"lexical-search/server"
)

func TestIndexSearchAndUpdate(t *testing.T) {
	oldDir, oldDB := config.LexDir, config.WorkspacesDBPath
	config.LexDir = filepath.Join(t.TempDir(), "indexes")
	config.WorkspacesDBPath = filepath.Join(config.LexDir, "workspaces.db")
	t.Cleanup(func() { config.LexDir, config.WorkspacesDBPath = oldDir, oldDB })
	gin.SetMode(gin.TestMode)
	router := gin.New()
	server.RegisterHandlersWithOptions(router, &Api{}, server.GinServerOptions{BaseURL: "/api/v1"})
	request := func(method, path string, body interface{}, status int) []byte {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, res.Code, res.Body.String())
		}
		return res.Body.Bytes()
	}
	source := t.TempDir()
	article := filepath.Join(source, "article.md")
	if err := os.WriteFile(article, []byte("Distinctive marmalade observations\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var created server.WorkspacesResponse
	if err := json.Unmarshal(request("POST", "/api/v1/workspaces", server.CreateWorkspaceRequest{Name: "fixture", WorkTree: source}, 201), &created); err != nil {
		t.Fatal(err)
	}
	id := created.Workspaces[0].Id.String()
	update := func() {
		t.Helper()
		output := request("GET", "/api/v1/updates?id="+id, []server.MontyDatabase{}, 200)
		if strings.Contains(string(output), "event: error") {
			t.Fatalf("update failed: %s", output)
		}
	}
	search := func(query string) server.SearchResponse {
		t.Helper()
		var result server.SearchResponse
		if err := json.Unmarshal(request("POST", "/api/v1/search", server.SearchRequest{Id: id, Databases: []server.MontyDatabase{}, Query: query, Limit: 10}, 200), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	update()
	result := search("marmalade")
	if len(result.Results) != 1 || !strings.Contains(result.Results[0].Document.Text, "marmalade") || !strings.HasSuffix(result.Results[0].Document.Path, "article.md") {
		t.Fatalf("unexpected results: %+v", result)
	}
	if err := os.WriteFile(article, []byte("Distinctive telescope observations\n"), 0600); err != nil {
		t.Fatal(err)
	}
	update()
	if len(search("marmalade").Results) != 0 || len(search("telescope").Results) != 1 {
		t.Fatal("updated text did not replace stale index entries")
	}
	if err := os.Remove(article); err != nil {
		t.Fatal(err)
	}
	update()
	if len(search("telescope").Results) != 0 {
		t.Fatal("deleted document remained indexed")
	}
}
