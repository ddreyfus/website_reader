package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"lexical-search/config"
)

func TestInventory(t *testing.T) {
	oldDir, oldDB, oldRoots := config.LexDir, config.WorkspacesDBPath, config.IndexDirectories
	root := t.TempDir()
	config.LexDir = filepath.Join(t.TempDir(), "indexes")
	config.WorkspacesDBPath = filepath.Join(config.LexDir, "workspaces.sqlite")
	config.IndexDirectories = []string{root}
	t.Cleanup(func() { config.LexDir, config.WorkspacesDBPath, config.IndexDirectories = oldDir, oldDB, oldRoots })
	batch := "# Issue\n## Contents\n- [First](#article-1)\n<a id=\"original-email\"></a>\n## Original email\nCommentary\n<a id=\"article-1\"></a>\n## First article é\n### Nested heading\nBody\n```\n<a id=\"article-99\"></a>\n## Fake article\n```\n<a id=\"article-2\"></a>\n## Second article\n> **Unavailable:** no content\n"
	files := map[string]string{"economist.md": batch, "nested/plain.txt": "Plain text without headings", "nested/headings.md": "# Heading C#\r\n" + strings.Repeat("x", 100000) + "\r\n~~~\r\n## Fake\r\n~~~\r\n## Actual\r\nbody", "empty.txt": ""}
	for path, text := range files {
		full := filepath.Join(root, path)
		os.MkdirAll(filepath.Dir(full), 0700)
		if err := os.WriteFile(full, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	reconcileDirectories(context.Background(), config.IndexDirectories)
	router := gin.New()
	RegisterRetrievalHandlers(router)
	get := func(path string, status int) map[string]interface{} {
		t.Helper()
		res := httptest.NewRecorder()
		router.ServeHTTP(res, httptest.NewRequest("GET", path, nil))
		if res.Code != status {
			t.Fatalf("%s: %d %s", path, res.Code, res.Body.String())
		}
		var value map[string]interface{}
		if err := json.Unmarshal(res.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	first := get("/api/v1/documents?limit=1", 200)
	if first["total"] != float64(3) || first["next_offset"] != float64(1) {
		t.Fatal(first)
	}
	docs := first["documents"].([]interface{})
	id := docs[0].(map[string]interface{})["document_id"].(string)
	second := get("/api/v1/documents?offset=1&limit=2", 200)
	if len(second["documents"].([]interface{})) != 2 || second["next_offset"] != nil {
		t.Fatal(second)
	}
	if len(get("/api/v1/documents?offset=100", 200)["documents"].([]interface{})) != 0 {
		t.Fatal("offset past end")
	}
	filtered := get("/api/v1/documents?path_contains=ECONOMIST", 200)
	if filtered["total"] != float64(1) {
		t.Fatal(filtered)
	}
	corpora := get("/api/v1/corpora", 200)["corpora"].([]interface{})
	var child string
	for _, raw := range corpora {
		c := raw.(map[string]interface{})
		if c["directory"] == "nested" {
			child = c["id"].(string)
		}
	}
	if get("/api/v1/documents?corpus_id="+child, 200)["total"] != float64(2) {
		t.Fatal("scope incorrect")
	}
	articles := get("/api/v1/documents/"+id+"/articles?limit=2", 200)
	if articles["total"] != float64(3) || articles["next_offset"] != float64(2) || articles["inventory_mode"] != "article_anchors" {
		t.Fatal(articles)
	}
	entries := articles["articles"].([]interface{})
	if entries[0].(map[string]interface{})["kind"] != "email" || entries[1].(map[string]interface{})["title"] != "First article é" {
		t.Fatal(entries)
	}
	article := entries[1].(map[string]interface{})
	read := get("/api/v1/documents/"+id+"?line=9", 200)
	if !strings.HasPrefix(read["text"].(string), "### Nested heading") {
		t.Fatal(read)
	}
	if article["line_start"] != float64(8) || article["line_end"] != float64(14) {
		t.Fatal(article)
	}
	tail := get("/api/v1/documents/"+id+"/articles?offset=2", 200)
	if tail["next_offset"] != nil || tail["articles"].([]interface{})[0].(map[string]interface{})["title"] != "Second article" {
		t.Fatal(tail)
	}
	for _, raw := range second["documents"].([]interface{}) {
		doc := raw.(map[string]interface{})
		inventory := get("/api/v1/documents/"+doc["document_id"].(string)+"/articles", 200)
		if inventory["inventory_mode"] != "headings" {
			t.Fatal(inventory)
		}
		if doc["path"] == "nested/headings.md" {
			items := inventory["articles"].([]interface{})
			if len(items) != 2 || items[0].(map[string]interface{})["title"] != "Heading C#" || items[1].(map[string]interface{})["line_start"] != float64(6) {
				t.Fatal(items)
			}
		} else if inventory["total"] != float64(0) {
			t.Fatal(inventory)
		}
	}
	for _, raw := range second["documents"].([]interface{}) {
		doc := raw.(map[string]interface{})
		if doc["path"] == "nested/headings.md" {
			os.WriteFile(filepath.Join(root, "nested/headings.md"), []byte("# "+strings.Repeat("x", 9000)), 0600)
			get("/api/v1/documents/"+doc["document_id"].(string)+"/articles", 422)
		}
	}
	get("/api/v1/documents?limit=101", 400)
	get("/api/v1/documents?offset=-1", 400)
	get("/api/v1/documents?corpus_id=bad", 404)
	get("/api/v1/documents/"+id+"/articles?limit=0", 400)
	get("/api/v1/documents/bad/articles", 404)
	os.Remove(filepath.Join(root, "economist.md"))
	get("/api/v1/documents/"+id+"/articles", 404)
	outside := filepath.Join(t.TempDir(), "outside.md")
	os.WriteFile(outside, []byte("# Outside"), 0600)
	os.Symlink(outside, filepath.Join(root, "economist.md"))
	get("/api/v1/documents/"+id+"/articles", 403)
}
