package routes

import (
	"context"
	"encoding/json"
	"lexical-search/config"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jmoiron/sqlx"
)

func TestChatGPTImportBranchesAndFreshness(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	db, err := sqlx.Connect("sqlite", filepath.Join(root, "queue.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err := RegisterChatGPTHandlers(gin.New(), db, root); err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(`{"id":"chat","title":"Export","update_time":1700000000,"current_node":"answer","mapping":{
"root":{"parent":null,"message":null},
"question":{"parent":"root","message":{"author":{"role":"user"},"content":{"parts":["Question"]}}},
"answer":{"parent":"question","message":{"author":{"role":"assistant"},"content":{"parts":["Selected answer"]}}},
"alternative":{"parent":"question","message":{"author":{"role":"assistant"},"content":{"parts":["Alternate answer"]}}}}}`)
	call := func(data json.RawMessage, dry bool, want string) {
		t.Helper()
		got, err := chatGPTImport(db, root, "personal", data, dry)
		if err != nil || got != want {
			t.Fatalf("%s %v; want %s", got, err, want)
		}
	}
	call(raw, true, "imported")
	var count int
	db.Get(&count, `SELECT COUNT(*) FROM chatgpt_conversations`)
	if count != 0 {
		t.Fatal("dry run modified database")
	}
	dir := filepath.Join(root, "personal", "conversations", "chat")
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("dry run wrote archive")
	}
	call(raw, false, "imported")
	main, _ := os.ReadFile(filepath.Join(dir, "conversation.md"))
	branches, _ := os.ReadFile(filepath.Join(dir, "branches.md"))
	if !strings.Contains(string(main), "Selected answer") || strings.Contains(string(main), "Alternate answer") || !strings.Contains(string(branches), "Alternate answer") || !strings.Contains(string(branches), "parent: question") {
		t.Fatal(string(main), string(branches))
	}
	oldDir, oldDB, oldRoots := config.LexDir, config.WorkspacesDBPath, config.IndexDirectories
	config.LexDir = filepath.Join(root, "indexes")
	config.WorkspacesDBPath = filepath.Join(config.LexDir, "workspaces.sqlite")
	config.IndexDirectories = []string{filepath.Join(root, "personal")}
	t.Cleanup(func() { config.LexDir, config.WorkspacesDBPath, config.IndexDirectories = oldDir, oldDB, oldRoots })
	reconcileDirectories(context.Background(), config.IndexDirectories)
	router := gin.New()
	RegisterRetrievalHandlers(router)
	res := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/v1/archive/search", strings.NewReader(`{"query":"Alternate answer"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(res, req)
	if res.Code != 200 || !strings.Contains(res.Body.String(), "branches.md") {
		t.Fatal("alternate branch not searchable", res.Body.String())
	}
	info, _ := os.Stat(filepath.Join(dir, "conversation.md"))
	call(raw, false, "unchanged")
	after, _ := os.Stat(filepath.Join(dir, "conversation.md"))
	if !info.ModTime().Equal(after.ModTime()) {
		t.Fatal("unchanged transcript rewritten")
	}
	if _, err := db.Exec(`UPDATE chatgpt_conversations SET project_id='g-p-existing',remote_updated_at='2026-10-11T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	call(raw, false, "branches-only")
	var project string
	db.Get(&project, `SELECT project_id FROM chatgpt_conversations`)
	if project != "g-p-existing" {
		t.Fatal("project assignment lost")
	}
	older := json.RawMessage(strings.Replace(string(raw), "1700000000", "1600000000", 1))
	call(older, false, "older-export")
	if _, err := db.Exec(`UPDATE chatgpt_conversations SET lease_until=9999999999`); err != nil {
		t.Fatal(err)
	}
	call(raw, false, "busy")
	broken := json.RawMessage(strings.Replace(string(raw), `"parent":"root"`, `"parent":"answer"`, 1))
	if _, err := chatGPTImport(db, root, "personal", broken, false); err == nil {
		t.Fatal("cycle accepted")
	}
}

// Optional integration check against a real export; always uses a temporary DB/archive.
func TestChatGPTImportExport(t *testing.T) {
	export := os.Getenv("CHATGPT_IMPORT_EXPORT")
	if export == "" {
		t.Skip("set CHATGPT_IMPORT_EXPORT to validate a real export")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	db, err := sqlx.Connect("sqlite", filepath.Join(root, "queue.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err := RegisterChatGPTHandlers(gin.New(), db, root); err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob(filepath.Join(export, "conversations*.json"))
	if err != nil || len(files) == 0 {
		t.Fatal("no export files", err)
	}
	count := 0
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var conversations []json.RawMessage
		if err := json.Unmarshal(data, &conversations); err != nil {
			t.Fatal(err)
		}
		for _, raw := range conversations {
			if _, err := chatGPTImport(db, root, "personal", raw, false); err != nil {
				var id struct {
					ID string `json:"id"`
				}
				json.Unmarshal(raw, &id)
				t.Fatalf("%s: %v", id.ID, err)
			}
			count++
		}
	}
	var rows int
	if err := db.Get(&rows, `SELECT COUNT(*) FROM chatgpt_conversations`); err != nil || rows != count {
		t.Fatal(rows, count, err)
	}
	t.Logf("Imported %d conversations into temporary archive and database", count)
}
