package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/blevesearch/bleve/v2"
	"github.com/gin-gonic/gin"
	"github.com/jmoiron/sqlx"
	"lexical-search/archive"
	"lexical-search/config"
)

func TestIngestionReconciliation(t *testing.T) {
	oldDir, oldDB, oldRoots := config.LexDir, config.WorkspacesDBPath, config.IndexDirectories
	config.LexDir = filepath.Join(t.TempDir(), "indexes")
	config.WorkspacesDBPath = filepath.Join(config.LexDir, "workspaces.sqlite")
	root := t.TempDir()
	config.IndexDirectories = []string{root}
	t.Cleanup(func() { config.LexDir, config.WorkspacesDBPath, config.IndexDirectories = oldDir, oldDB, oldRoots })
	// Exercise the whole orchestration without making Java an unconditional test dependency.
	bin := t.TempDir()
	java := "#!/bin/sh\nfor source do :; done\nif /usr/bin/grep -q FAIL \"$source\"; then echo parser-failed >&2; exit 1; fi\n/bin/cat \"$source\"\n"
	if err := os.WriteFile(filepath.Join(bin, "java"), []byte(java), 0700); err != nil {
		t.Fatal(err)
	}
	jar := filepath.Join(bin, "tika.jar")
	os.WriteFile(jar, []byte("test parser"), 0600)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("TIKA_APP_JAR", jar)
	text := `<html><body><div class="page"><h1>Evidence</h1><p>marmaladeneedle é</p></div><div class="page"><h2>Conclusion</h2><p>telescopeneedle</p></div></body></html>`
	source := filepath.Join(root, "report.pdf")
	os.WriteFile(source, []byte(text), 0600)
	os.WriteFile(filepath.Join(root, "empty.txt"), nil, 0600)
	os.WriteFile(filepath.Join(root, "untouched.txt"), []byte("keep original"), 0600)
	reconcile := func() { t.Helper(); reconcileDirectories(context.Background(), config.IndexDirectories) }
	reconcile()
	workspace := mustWorkspaces(t)[0]
	cache := archive.TextPath(&workspace, "report.pdf")
	db, err := sqlx.Connect("sqlite", archive.MakeArchiveDBPath(workspace.Id))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	id := archiveID(workspace, "report.pdf")
	router := gin.New()
	RegisterRetrievalHandlers(router)
	get := func(path string, status int) map[string]interface{} {
		t.Helper()
		res := httptest.NewRecorder()
		router.ServeHTTP(res, httptest.NewRequest("GET", path, nil))
		if res.Code != status {
			t.Fatalf("%s: %d %s", path, res.Code, res.Body.String())
		}
		var result map[string]interface{}
		if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	read := func() {
		t.Helper()
		result := get("/api/v1/documents/"+id, 200)
		if !strings.Contains(result["text"].(string), "## Page 2") {
			t.Fatal(result)
		}
	}
	read()
	inventory := get("/api/v1/documents/"+id+"/articles", 200)
	if inventory["total"] != float64(4) {
		t.Fatal(inventory)
	}
	var initial string
	db.Get(&initial, "SELECT id FROM fileChunks WHERE path='report.pdf' LIMIT 1")
	reconcile()
	var unchanged string
	db.Get(&unchanged, "SELECT id FROM fileChunks WHERE path='report.pdf' LIMIT 1")
	if initial != unchanged {
		t.Fatal("unchanged file reindexed")
	}
	for _, damage := range []string{"state", "chunks", "bleve", "cache", "corrupt-cache", "version"} {
		t.Run(damage, func(t *testing.T) {
			switch damage {
			case "state":
				db.Exec("DELETE FROM ingestion WHERE path='report.pdf'")
			case "chunks":
				db.Exec("DELETE FROM fileChunks WHERE path='report.pdf'")
			case "bleve":
				var ids []string
				db.Select(&ids, "SELECT id FROM fileChunks WHERE path='report.pdf'")
				index, err := bleve.Open(workspace.BleveDir)
				if err != nil {
					t.Fatal(err)
				}
				for _, id := range ids {
					if err := index.Delete(id); err != nil {
						t.Fatal(err)
					}
				}
				index.Close()
			case "cache":
				os.Remove(cache)
			case "corrupt-cache":
				os.WriteFile(cache, []byte("damaged text"), 0600)
			case "version":
				db.Exec("UPDATE ingestion SET version='old' WHERE path='report.pdf'")
			}
			reconcile()
			read()
			var count int
			db.Get(&count, "SELECT COUNT(*) FROM fileChunks WHERE path='report.pdf'")
			index, err := bleve.Open(workspace.BleveDir)
			if err != nil {
				t.Fatal(err)
			}
			indexed, err := index.DocCount()
			index.Close()
			if err != nil {
				t.Fatal(err)
			}
			var all int
			db.Get(&all, "SELECT COUNT(*) FROM fileChunks")
			if count == 0 || indexed != uint64(all) {
				t.Fatalf("database/index mismatch %d vs %d", all, indexed)
			}
		})
	}
	// Keep Tika busy while exercising reads and a second scanner in this process.
	ready, resume := filepath.Join(bin, "ready"), filepath.Join(bin, "resume")
	blocking := fmt.Sprintf("#!/bin/sh\nfor source do :; done\n/usr/bin/touch %q\nwhile [ ! -e %q ]; do /bin/sleep 0.01; done\n/bin/cat \"$source\"\n", ready, resume)
	if err := os.WriteFile(filepath.Join(bin, "java"), []byte(blocking), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(strings.Replace(text, "marmaladeneedle", "replacementneedle", 1)), 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { reconcile(); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			os.WriteFile(resume, nil, 0600)
			<-done
			t.Fatal("extractor did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	var current string
	if err := db.Get(&current, "SELECT id FROM fileChunks WHERE path='report.pdf' LIMIT 1"); err != nil {
		os.WriteFile(resume, nil, 0600)
		<-done
		t.Fatal(err)
	}
	readDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		res := httptest.NewRecorder()
		router.ServeHTTP(res, httptest.NewRequest("GET", "/api/v1/documents/"+id+"?chunk_id="+current, nil))
		readDone <- res
	}()
	select {
	case res := <-readDone:
		if res.Code != 200 || !strings.Contains(res.Body.String(), "marmaladeneedle") {
			os.WriteFile(resume, nil, 0600)
			<-done
			t.Fatal(res.Code, res.Body.String())
		}
	case <-time.After(2 * time.Second):
		os.WriteFile(resume, nil, 0600)
		<-done
		t.Fatal("read blocked during extraction")
	}
	second := make(chan struct{})
	go func() { reconcile(); close(second) }()
	select {
	case <-second:
	case <-time.After(2 * time.Second):
		os.WriteFile(resume, nil, 0600)
		<-done
		t.Fatal("second scanner blocked")
	}
	var owner int
	if err := db.Get(&owner, "SELECT job_pid FROM ingestion WHERE path='report.pdf'"); err != nil || owner != os.Getpid() {
		os.WriteFile(resume, nil, 0600)
		<-done
		t.Fatal("active job lost", owner, err)
	}
	if _, err := os.Stat(cache + ".job"); err != nil {
		os.WriteFile(resume, nil, 0600)
		<-done
		t.Fatal("active effort removed")
	}
	os.WriteFile(resume, nil, 0600)
	<-done
	if !strings.Contains(get("/api/v1/documents/"+id, 200)["text"].(string), "replacementneedle") {
		t.Fatal("new version not published")
	}
	os.WriteFile(filepath.Join(bin, "java"), []byte(java), 0700)
	// A failed extraction must not look successfully ingested and must retry unchanged files.
	os.WriteFile(source, []byte("FAIL"), 0600)
	reconcile()
	var failure string
	db.Get(&failure, "SELECT error FROM ingestion WHERE path='report.pdf'")
	if !strings.Contains(failure, "parser-failed") {
		t.Fatal(failure)
	}
	// Recover the parser without touching the failed source.
	os.WriteFile(filepath.Join(bin, "java"), []byte("#!/bin/sh\nprintf '<html><body><h1>Recovered</h1><p>recoveredneedle</p></body></html>'\n"), 0700)
	reconcile()
	db.Get(&failure, "SELECT error FROM ingestion WHERE path='report.pdf'")
	if failure != "" {
		t.Fatal(failure)
	}
	if !strings.Contains(get("/api/v1/documents/"+id, 200)["text"].(string), "recoveredneedle") {
		t.Fatal("retry failed")
	}
	os.Remove(source)
	reconcile()
	get("/api/v1/documents/"+id, 404)
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatal("deleted source retained cache")
	}
	if original, err := os.ReadFile(filepath.Join(root, "untouched.txt")); err != nil || string(original) != "keep original" {
		t.Fatal("original text modified")
	}
	var emptyCount int
	db.Get(&emptyCount, "SELECT COUNT(*) FROM ingestion WHERE path='empty.txt' AND chunks=0 AND error=''")
	if emptyCount != 1 {
		t.Fatal("empty file not tracked")
	}
}

// Run against real files with TIKA_TEST_JAR and TIKA_TEST_SOURCES; all state is isolated.
func TestTikaSampleRetrieval(t *testing.T) {
	jar, samples := os.Getenv("TIKA_TEST_JAR"), os.Getenv("TIKA_TEST_SOURCES")
	if jar == "" || samples == "" {
		t.Skip("set TIKA_TEST_JAR and TIKA_TEST_SOURCES for actual parser integration")
	}
	t.Setenv("TIKA_APP_JAR", jar)
	oldDir, oldDB, oldRoots := config.LexDir, config.WorkspacesDBPath, config.IndexDirectories
	config.LexDir = filepath.Join(t.TempDir(), "indexes")
	config.WorkspacesDBPath = filepath.Join(config.LexDir, "workspaces.sqlite")
	root := t.TempDir()
	config.IndexDirectories = []string{root}
	t.Cleanup(func() { config.LexDir, config.WorkspacesDBPath, config.IndexDirectories = oldDir, oldDB, oldRoots })
	files, err := os.ReadDir(samples)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, file := range files {
		if file.IsDir() || !archive.NeedsExtraction(file.Name()) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(samples, file.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, file.Name()), data, 0600); err != nil {
			t.Fatal(err)
		}
		count++
	}
	if count == 0 {
		t.Fatal("no supported samples")
	}
	reconcileDirectories(context.Background(), config.IndexDirectories)
	workspace := mustWorkspaces(t)[0]
	db, err := sqlx.Connect("sqlite", archive.MakeArchiveDBPath(workspace.Id))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var failures []string
	if err := db.Select(&failures, "SELECT path || ': ' || error FROM ingestion WHERE error != ''"); err != nil {
		t.Fatal(err)
	}
	if len(failures) > 0 {
		t.Fatal(failures)
	}
	router := gin.New()
	RegisterRetrievalHandlers(router)
	records, err := fileChunks(workspace)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, record := range records {
		if seen[record.Path] {
			continue
		}
		seen[record.Path] = true
		res := httptest.NewRecorder()
		router.ServeHTTP(res, httptest.NewRequest("GET", "/api/v1/documents/"+archiveID(workspace, record.Path)+"?chunk_id="+record.Id.String(), nil))
		if res.Code != 200 {
			t.Fatalf("%s: %d %s", record.Path, res.Code, res.Body.String())
		}
		var result map[string]interface{}
		json.Unmarshal(res.Body.Bytes(), &result)
		if strings.TrimSpace(result["text"].(string)) == "" {
			t.Fatal("empty read", record.Path)
		}
		text := result["text"].(string)
		if strings.HasSuffix(record.Path, ".pdf") && !strings.Contains(text, "## Page 1") {
			t.Fatal("PDF page boundary lost", record.Path)
		}
		if strings.HasSuffix(record.Path, ".html") || strings.HasSuffix(record.Path, ".htm") {
			for _, excluded := range []string{"SCRIPT_NOISE", "STYLE_NOISE"} {
				if strings.Contains(text, excluded) {
					t.Fatal("HTML boilerplate retained", excluded)
				}
			}
			for _, expected := range []string{"# Saved research é", "## Results", "https://example.org/evidence", "Alpha", "42"} {
				if !strings.Contains(text, expected) {
					t.Fatal("HTML structure lost", expected)
				}
			}
		}
		query := regexp.MustCompile(`[\p{L}]{5,}`).FindString(text)
		if query == "" {
			t.Fatal("no searchable words", record.Path)
		}
		body, _ := json.Marshal(map[string]interface{}{"query": query, "limit": 100})
		search := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/v1/archive/search", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(search, req)
		var hits map[string]interface{}
		if search.Code != 200 || json.Unmarshal(search.Body.Bytes(), &hits) != nil {
			t.Fatal(search.Body.String())
		}
		found := false
		for _, raw := range hits["results"].([]interface{}) {
			if raw.(map[string]interface{})["path"] == record.Path {
				found = true
			}
		}
		if !found {
			t.Fatal("document missing from actual search", record.Path, query)
		}
		t.Logf("%s: search and chunk retrieval OK", record.Path)
	}
	if len(seen) != count {
		t.Fatalf("indexed %d/%d files", len(seen), count)
	}
}
