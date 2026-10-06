package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"lexical-search/archive"
	"log"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"lexical-search/config"
)

func TestArchiveRetrieval(t *testing.T) {
	oldDir, oldDB, oldRoots := config.LexDir, config.WorkspacesDBPath, config.IndexDirectories
	config.LexDir = filepath.Join(t.TempDir(), "indexes")
	config.WorkspacesDBPath = filepath.Join(config.LexDir, "workspaces.sqlite")
	root := t.TempDir()
	config.IndexDirectories = []string{root}
	t.Cleanup(func() { config.LexDir, config.WorkspacesDBPath, config.IndexDirectories = oldDir, oldDB, oldRoots })
	files := map[string]string{
		"overlap-full.txt":          "abcdef uvwxyz",
		"overlap-word.txt":          "abcdef qqqqqq",
		"overlap-gram.txt":          "abc qqqqqqqqqq",
		"Medium/article.md":         "Heading\nsharedneedle Medium story <script>alert(1)</script>\n",
		"Medium/Project A/long.txt": strings.Repeat("long prose é ", 10000) + "zyxwvuts",
		"MediumExtra/article.md":    "sharedneedle sibling story\n",
	}
	for path, text := range files {
		full := filepath.Join(root, path)
		os.MkdirAll(filepath.Dir(full), 0700)
		if err := os.WriteFile(full, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 35; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("ranking-%d.md", i)), []byte(strings.Repeat("rankingword ", i+1)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	reconcileDirectories(context.Background(), config.IndexDirectories)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterRetrievalHandlers(router)
	request := func(method, path string, body interface{}, expected int) []byte {
		t.Helper()
		data, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, strings.NewReader(string(data)))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		var captured bytes.Buffer
		previous := log.Writer()
		log.SetOutput(&captured)
		router.ServeHTTP(res, req)
		log.SetOutput(previous)
		if path == "/api/v1/archive/search" {
			var entry map[string]interface{}
			for _, line := range strings.Split(captured.String(), "\n") {
				if start := strings.Index(line, "{"); start >= 0 {
					var candidate map[string]interface{}
					if json.Unmarshal([]byte(line[start:]), &candidate) == nil && candidate["event"] == "archive_search" {
						entry = candidate
					}
				}
			}
			if entry == nil || entry["status"] != float64(expected) || entry["duration_ms"] == nil || entry["timestamp"] == nil {
				t.Fatalf("missing search log: %s", captured.String())
			}
			if expected >= 400 && entry["error"] == nil {
				t.Fatal("failed search did not log error")
			}
			if expected == 200 {
				var response map[string]interface{}
				json.Unmarshal(res.Body.Bytes(), &response)
				returned := response["results"].([]interface{})
				logged := entry["results"].([]interface{})
				if entry["returned_count"] != float64(len(returned)) || len(logged) != len(returned) || entry["total_matches"].(float64) < float64(len(returned)) {
					t.Fatal("search log counts mismatch")
				}
				for i, hit := range logged {
					fields := hit.(map[string]interface{})
					actual := returned[i].(map[string]interface{})
					if len(fields) != 3 || fields["document_id"] != actual["document_id"] || fields["chunk_id"] != actual["chunk_id"] || fields["score"] != actual["score"] {
						t.Fatal("search log result metadata mismatch or passage content logged")
					}
				}
				if body.(map[string]interface{})["query"] != entry["query"] {
					t.Fatal("query not logged")
				}
			}
		}
		if res.Code != expected {
			t.Fatalf("%s %s: %d %s", method, path, res.Code, res.Body.String())
		}
		return res.Body.Bytes()
	}
	decode := func(data []byte) map[string]interface{} {
		t.Helper()
		var body map[string]interface{}
		if err := json.Unmarshal(data, &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	corpora := decode(request("GET", "/api/v1/corpora", nil, 200))["corpora"].([]interface{})
	ids := map[string]string{}
	for _, item := range corpora {
		corpus := item.(map[string]interface{})
		ids[corpus["directory"].(string)] = corpus["id"].(string)
	}
	ranked := decode(request("POST", "/api/v1/archive/search", map[string]interface{}{"query": "rankingword"}, 200))["results"].([]interface{})
	if len(ranked) != 30 {
		t.Fatalf("default result count: %d", len(ranked))
	}
	for i := 1; i < len(ranked); i++ {
		if ranked[i-1].(map[string]interface{})["score"].(float64) < ranked[i].(map[string]interface{})["score"].(float64) {
			t.Fatal("results are not ordered by relevance")
		}
	}
	limited := decode(request("POST", "/api/v1/archive/search", map[string]interface{}{"query": "rankingword", "limit": 5}, 200))["results"].([]interface{})
	if len(limited) != 5 {
		t.Fatal("per-query result limit ignored")
	}
	oldLimit := config.SearchLimit
	config.SearchLimit = 7
	configured := decode(request("POST", "/api/v1/archive/search", map[string]interface{}{"query": "rankingword"}, 200))["results"].([]interface{})
	config.SearchLimit = oldLimit
	if len(configured) != 7 {
		t.Fatal("configured default ignored")
	}
	if len(ids) != 4 {
		t.Fatalf("hierarchy: %+v", ids)
	}
	for _, item := range corpora {
		corpus := item.(map[string]interface{})
		if corpus["directory"] == "Medium/Project A" && corpus["parent_id"] != ids["Medium"] {
			t.Fatal("incorrect parent")
		}
		if corpus["directory"] == "Medium" && corpus["document_count"] != float64(2) {
			t.Fatal("incorrect recursive count")
		}
	}
	search := func(query string, corpusIDs []string) []interface{} {
		t.Helper()
		return decode(request("POST", "/api/v1/archive/search", map[string]interface{}{"query": query, "corpus_ids": corpusIDs, "limit": 10}, 200))["results"].([]interface{})
	}
	overlap := search("ABCDEF UVWXYZ", nil)
	if len(overlap) != 3 || overlap[0].(map[string]interface{})["path"] != "overlap-full.txt" {
		t.Fatalf("OR trigrams must match partial words and rank stronger overlap first: %+v", overlap)
	}
	if len(search("sharedneedle", nil)) != 2 {
		t.Fatal("whole archive search did not combine corpora")
	}
	scoped := search("sharedneedle", []string{ids["Medium"], ids["Medium/Project A"]})
	if len(scoped) != 1 {
		t.Fatal("scope leaked into sibling or duplicated child results")
	}
	if len(search("zyxwvuts", []string{ids["Medium"]})) != 1 {
		t.Fatal("parent omitted descendant")
	}
	if len(search("sharedneedle", []string{ids["Medium/Project A"]})) != 0 {
		t.Fatal("child scope included parent's files")
	}
	match := scoped[0].(map[string]interface{})
	id := match["document_id"].(string)
	document := decode(request("GET", "/api/v1/documents/"+id+"?line=2", nil, 200))
	if document["text"] != "sharedneedle Medium story <script>alert(1)</script>\n" || document["truncated"] != false {
		t.Fatal("incorrect document context", document)
	}
	html := string(request("GET", match["url"].(string), nil, 200))
	if strings.Contains(html, "<script>") || !strings.Contains(html, "&lt;script&gt;") {
		t.Fatal("viewer did not escape source HTML")
	}
	longID := search("zyxwvuts", nil)[0].(map[string]interface{})["document_id"].(string)
	exact := search("zyxwvuts", nil)[0].(map[string]interface{})
	passage := decode(request("GET", "/api/v1/documents/"+longID+"?chunk_id="+exact["chunk_id"].(string), nil, 200))
	if !strings.Contains(passage["text"].(string), "zyxwvuts") || passage["offset"].(float64) == 0 {
		t.Fatal("matching long-line passage was not located")
	}
	first := decode(request("GET", "/api/v1/documents/"+longID+"?limit=256", nil, 200))
	if len(first["text"].(string)) > 256 || first["truncated"] != true {
		t.Fatal("unbounded document read")
	}
	second := decode(request("GET", "/api/v1/documents/"+longID+"?limit=256&offset="+strconv.FormatInt(int64(first["next_offset"].(float64)), 10), nil, 200))
	if second["offset"] != first["next_offset"] {
		t.Fatal("pagination gap")
	}
	request("GET", "/api/v1/documents/"+longID+"?limit=1", nil, 400)
	request("GET", "/api/v1/documents/"+id+"?line=2&offset=0", nil, 400)
	workspace, _, err := parseArchiveID(id, mustWorkspaces(t))
	if err != nil {
		t.Fatal(err)
	}
	request("GET", "/api/v1/documents/"+archiveID(workspace, "../outside.txt"), nil, 404)
	target := filepath.Join(root, "Medium/article.md")
	os.Remove(target)
	outside := filepath.Join(t.TempDir(), "secret.txt")
	os.WriteFile(outside, []byte("private"), 0600)
	os.Symlink(outside, target)
	request("GET", "/api/v1/documents/"+id, nil, 403)
}

func mustWorkspaces(t *testing.T) []archive.WorkspaceRecord {
	t.Helper()
	workspaces, unlock, err := lockArchiveWorkspaces()
	if err != nil {
		t.Fatal(err)
	}
	unlock()
	return workspaces
}
