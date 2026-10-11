package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"lexical-search/config"
	"log"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

func TestChatGPTQueueAndSnapshots(t *testing.T) {
	var diagnostics bytes.Buffer
	previousLog := log.Writer()
	log.SetOutput(&diagnostics)
	defer log.SetOutput(previousLog)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	db, err := sqlx.Connect("sqlite", filepath.Join(dir, "queue.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	router := gin.New()
	root := filepath.Join(dir, "sources", "ChatGPT")
	if err = RegisterChatGPTHandlers(router, db, root); err != nil {
		t.Fatal(err)
	}
	call := func(action string, body map[string]interface{}, want int) map[string]interface{} {
		t.Helper()
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", "/api/v1/chatgpt/"+action, strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "chrome-extension://test")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != want {
			t.Fatalf("%s: %d %s", action, res.Code, res.Body.String())
		}
		var result map[string]interface{}
		json.Unmarshal(res.Body.Bytes(), &result)
		return result
	}
	discover := map[string]interface{}{"scope": "account-a", "checkpoint": map[string]interface{}{"complete": true}, "conversations": []map[string]interface{}{{"id": "chat-1", "title": "First title", "project_id": "g-p-project", "project_title": "Project"}}}
	call("discover", discover, 200)
	call("discover", discover, 200)
	var rows, projects int
	db.Get(&rows, "SELECT COUNT(*) FROM chatgpt_conversations")
	db.Get(&projects, "SELECT COUNT(*) FROM chatgpt_projects")
	if rows != 1 || projects != 1 {
		t.Fatal(rows, projects)
	}
	// Project-only discovery persists empty projects and exposes scoped names.
	call("discover", map[string]interface{}{"scope": "account-a", "projects": map[string]string{"g-p-empty": "Empty"}}, 200)
	for _, scope := range []string{"account-a", "account-b"} {
		res := httptest.NewRecorder()
		router.ServeHTTP(res, httptest.NewRequest("GET", "/api/v1/chatgpt/checkpoint?scope="+scope, nil))
		if res.Code != 200 {
			t.Fatal(res.Code, res.Body.String())
		}
		var result struct {
			Projects map[string]string `json:"projects"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if scope == "account-a" {
			if result.Projects["g-p-empty"] != "Empty" || result.Projects["g-p-project"] != "Project" {
				t.Fatal(result.Projects)
			}
		} else if len(result.Projects) != 0 {
			t.Fatal("project names leaked across scopes", result.Projects)
		}
	}
	claim := call("claim", map[string]interface{}{"scope": "account-a"}, 200)["job"].(map[string]interface{})
	if call("claim", map[string]interface{}{"scope": "account-a"}, 200)["job"] != nil {
		t.Fatal("duplicate claim")
	}
	snapshot := map[string]interface{}{"id": "chat-1", "coverage": "rendered", "messages": []map[string]string{{"role": "user", "text": "What is RAG?"}, {"role": "assistant", "text": "Retrieval with evidence."}}}
	save := map[string]interface{}{"scope": "account-a", "id": "chat-1", "lease": claim["lease"], "generation": claim["generation"], "snapshot": snapshot}
	// An observation made while fetching must remain pending after the old save.
	discover["conversations"].([]map[string]interface{})[0]["title"] = "Renamed"
	call("discover", discover, 200)
	call("save", save, 200)
	var generation, saved int
	db.QueryRow("SELECT generation,saved_generation FROM chatgpt_conversations").Scan(&generation, &saved)
	if generation != 2 || saved != 1 {
		t.Fatal(generation, saved)
	}
	claim = call("claim", map[string]interface{}{"scope": "account-a"}, 200)["job"].(map[string]interface{})
	// Previous owner cannot overwrite the new owner's job.
	call("save", save, 409)
	save["lease"] = claim["lease"]
	save["generation"] = claim["generation"]
	call("save", save, 200)
	md := filepath.Join(root, "account-a", "conversations", "chat-1", "conversation.md")
	data, err := os.ReadFile(md)
	if err != nil || !strings.Contains(string(data), "## user") || !strings.Contains(string(data), "https://chatgpt.com/g/g-p-project/c/chat-1") {
		t.Fatal(string(data), err)
	}
	before, _ := os.Stat(md)
	call("recheck", map[string]interface{}{"scope": "account-a"}, 200)
	if job := call("claim", map[string]interface{}{"scope": "account-a"}, 200)["job"]; job != nil {
		t.Fatal("fresh snapshot requeued", job)
	}
	if _, err := db.Exec("UPDATE chatgpt_conversations SET saved_at=0 WHERE scope=?", "account-a"); err != nil {
		t.Fatal(err)
	}
	call("recheck", map[string]interface{}{"scope": "account-a"}, 200)
	claim = call("claim", map[string]interface{}{"scope": "account-a"}, 200)["job"].(map[string]interface{})
	save["lease"] = claim["lease"]
	save["generation"] = claim["generation"]
	call("save", save, 200)
	after, _ := os.Stat(md)
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("unchanged content rewritten")
	}
	files, _ := filepath.Glob(filepath.Join(filepath.Dir(md), "*.json"))
	if len(files) != 1 {
		t.Fatal("duplicate revision", files)
	}

	// Saved snapshots use the ordinary archive indexing and retrieval path.
	oldDir, oldDB, oldRoots := config.LexDir, config.WorkspacesDBPath, config.IndexDirectories
	config.LexDir = filepath.Join(dir, "indexes")
	config.WorkspacesDBPath = filepath.Join(config.LexDir, "workspaces.sqlite")
	config.IndexDirectories = []string{root}
	t.Cleanup(func() { config.LexDir, config.WorkspacesDBPath, config.IndexDirectories = oldDir, oldDB, oldRoots })
	reconcileDirectories(context.Background(), config.IndexDirectories)
	RegisterRetrievalHandlers(router)
	search := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/api/v1/archive/search", strings.NewReader(`{"query":"Retrieval with evidence"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(search, request)
	var found struct {
		Results []struct {
			DocumentID string `json:"document_id"`
		} `json:"results"`
	}
	if search.Code != 200 || json.Unmarshal(search.Body.Bytes(), &found) != nil || len(found.Results) == 0 {
		t.Fatalf("snapshot not searchable: %d %s", search.Code, search.Body.String())
	}
	document := httptest.NewRecorder()
	router.ServeHTTP(document, httptest.NewRequest("GET", "/api/v1/documents/"+found.Results[0].DocumentID, nil))
	if document.Code != 200 || !strings.Contains(document.Body.String(), "## assistant") || !strings.Contains(document.Body.String(), "https://chatgpt.com/") {
		t.Fatalf("missing conversation context: %s", document.Body.String())
	}
	// Identical remote IDs in another account are independent.
	discover["scope"] = "account-b"
	call("discover", discover, 200)
	db.Get(&rows, "SELECT COUNT(*) FROM chatgpt_conversations")
	if rows != 2 {
		t.Fatal(rows)
	}
	claim = call("claim", map[string]interface{}{"scope": "account-b"}, 200)["job"].(map[string]interface{})
	db.Exec("UPDATE chatgpt_conversations SET lease_until=0 WHERE scope='account-b'")
	newer := call("claim", map[string]interface{}{"scope": "account-b"}, 200)["job"].(map[string]interface{})
	if claim["lease"] == newer["lease"] {
		t.Fatal("lease not replaced")
	}
	call("fail", map[string]interface{}{"scope": "account-b", "id": "chat-1", "lease": claim["lease"], "error": "old worker"}, 409)
	call("fail", map[string]interface{}{"scope": "account-b", "id": "chat-1", "lease": newer["lease"], "error": "login needed"}, 200)
	if call("claim", map[string]interface{}{"scope": "account-b"}, 200)["job"] != nil {
		t.Fatal("retry backoff ignored")
	}
	call("discover", map[string]interface{}{"scope": "../escape", "conversations": []interface{}{}}, 400)
	req := httptest.NewRequest("POST", "/api/v1/chatgpt/claim", strings.NewReader(`{"scope":"account-a"}`))
	req.Header.Set("Origin", "https://chatgpt.com")
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != 403 {
		t.Fatal(res.Code)
	}
	// A symlink in the destination must not redirect writes.
	outside := filepath.Join(dir, "outside")
	os.Mkdir(outside, 0700)
	os.Symlink(outside, filepath.Join(root, "account-b"))
	db.Exec("UPDATE chatgpt_conversations SET retry_at=0 WHERE scope='account-b'")
	newer = call("claim", map[string]interface{}{"scope": "account-b"}, 200)["job"].(map[string]interface{})
	save["scope"] = "account-b"
	save["lease"] = newer["lease"]
	save["generation"] = newer["generation"]
	call("save", save, 500)
	entries, _ := os.ReadDir(outside)
	if len(entries) != 0 {
		t.Fatal("write escaped root")
	}
	// A deleted conversation stays failed until discovery advances its generation.
	deletedEntry := map[string]interface{}{"id": "deleted", "title": "Deleted", "updated_at": "2026-10-09T18:00:00Z"}
	deletedDiscovery := map[string]interface{}{"scope": "deleted", "conversations": []map[string]interface{}{deletedEntry}}
	call("discover", deletedDiscovery, 200)
	deletedJob := call("claim", map[string]interface{}{"scope": "deleted"}, 200)["job"].(map[string]interface{})
	deletedJob["scope"] = "deleted"
	deletedJob["error"] = "ChatGPT conversation returned HTTP 404. Endpoint unavailable"
	call("fail", deletedJob, 200)
	call("discover", deletedDiscovery, 200)
	if call("claim", map[string]interface{}{"scope": "deleted"}, 200)["job"] != nil {
		t.Fatal("unchanged deleted conversation was retried")
	}
	var parked, unsaved int
	db.Get(&parked, "SELECT retry_at FROM chatgpt_conversations WHERE scope='deleted'")
	db.Get(&unsaved, "SELECT saved_generation FROM chatgpt_conversations WHERE scope='deleted'")
	if parked != -1 || unsaved != 0 {
		t.Fatal("deleted failure was not parked or was marked saved", parked, unsaved)
	}
	statusResponse := httptest.NewRecorder()
	router.ServeHTTP(statusResponse, httptest.NewRequest("GET", "/api/v1/chatgpt/status?scope=deleted", nil))
	var status struct {
		Conversations []struct {
			RetryAt int64 `json:"retry_at"`
		} `json:"conversations"`
	}
	if err := json.Unmarshal(statusResponse.Body.Bytes(), &status); err != nil || statusResponse.Code != 200 || len(status.Conversations) != 1 || status.Conversations[0].RetryAt != -1 {
		t.Fatal("status omitted parked retry state", statusResponse.Body.String(), err)
	}
	deletedEntry["updated_at"] = "2026-10-09T19:00:00Z"
	call("discover", deletedDiscovery, 200)
	if call("claim", map[string]interface{}{"scope": "deleted"}, 200)["job"] == nil {
		t.Fatal("changed deleted conversation remained parked")
	}

	// Confirmed deletion removes files and partial pages without affecting neighbors.
	deletedDir := filepath.Join(root, "deleted", "conversations", "deleted")
	if err := chatGPTDirectory(deletedDir); err != nil {
		t.Fatal(err)
	}
	if err := chatGPTWrite(filepath.Join(deletedDir, "conversation.md"), []byte("deletedconversationuniquetoken")); err != nil {
		t.Fatal(err)
	}
	reconcileDirectories(context.Background(), config.IndexDirectories)
	beforeDeletion := httptest.NewRecorder()
	beforeRequest := httptest.NewRequest("POST", "/api/v1/archive/search", strings.NewReader(`{"query":"deletedconversationuniquetoken"}`))
	beforeRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(beforeDeletion, beforeRequest)
	if beforeDeletion.Code != 200 || !strings.Contains(beforeDeletion.Body.String(), "deletedconversationuniquetoken") {
		t.Fatal("deletion fixture was not indexed", beforeDeletion.Body.String())
	}
	db.Exec("INSERT INTO chatgpt_pages(scope,id,generation,cursor,body) VALUES('deleted','deleted',2,'','{}')")
	var lease string
	db.Get(&lease, "SELECT lease FROM chatgpt_conversations WHERE scope='deleted'")
	call("fail", map[string]interface{}{"scope": "deleted", "id": "deleted", "lease": lease, "error": "ChatGPT conversation returned HTTP 404. error=conversation_deleted"}, 200)
	if _, err := os.Stat(deletedDir); !os.IsNotExist(err) {
		t.Fatal("deleted transcript retained", err)
	}
	var remaining int
	db.Get(&remaining, "SELECT (SELECT COUNT(*) FROM chatgpt_conversations WHERE scope='deleted')+(SELECT COUNT(*) FROM chatgpt_pages WHERE scope='deleted')")
	if remaining != 0 {
		t.Fatal("deleted database entries retained", remaining)
	}
	reconcileDirectories(context.Background(), config.IndexDirectories)
	removedSearch := httptest.NewRecorder()
	removedRequest := httptest.NewRequest("POST", "/api/v1/archive/search", strings.NewReader(`{"query":"deletedconversationuniquetoken"}`))
	removedRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(removedSearch, removedRequest)
	if removedSearch.Code != 200 || strings.Contains(removedSearch.Body.String(), "deletedconversationuniquetoken") {
		t.Fatal("deleted content remained searchable", removedSearch.Code, removedSearch.Body.String())
	}

	// Startup also removes confirmed failures parked by older service versions.
	if err := chatGPTDirectory(deletedDir); err != nil {
		t.Fatal(err)
	}
	if err := chatGPTWrite(filepath.Join(deletedDir, "export.json"), []byte("{}")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO chatgpt_conversations(scope,id,title,url,retry_at,error) VALUES('deleted','deleted','Deleted','https://chatgpt.com/c/deleted',-1,'ChatGPT conversation returned HTTP 404. error=conversation_deleted')`); err != nil {
		t.Fatal(err)
	}
	if err := RegisterChatGPTHandlers(gin.New(), db, root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(deletedDir); !os.IsNotExist(err) {
		t.Fatal("startup retained deleted export", err)
	}
	db.Get(&remaining, "SELECT COUNT(*) FROM chatgpt_conversations WHERE scope='deleted'")
	if remaining != 0 {
		t.Fatal("startup retained deleted queue entry")
	}

	// A failed low-ID job must not starve untouched conversations.
	call("discover", map[string]interface{}{"scope": "fair", "checkpoint": map[string]interface{}{"complete": true}, "conversations": []map[string]interface{}{{"id": "a", "title": "Retry"}, {"id": "b", "title": "Untouched"}}}, 200)
	failedJob := call("claim", map[string]interface{}{"scope": "fair"}, 200)["job"].(map[string]interface{})
	failedJob["scope"] = "fair"
	failedJob["error"] = "temporary failure"
	call("fail", failedJob, 200)
	db.Exec("UPDATE chatgpt_conversations SET retry_at=1 WHERE scope='fair' AND id='a'")
	call("discover", map[string]interface{}{"scope": "fair", "checkpoint": map[string]interface{}{"complete": false, "completedAt": 1}}, 200)
	if next := call("claim", map[string]interface{}{"scope": "fair"}, 200)["job"].(map[string]interface{}); next["id"] != "b" {
		t.Fatal("retry starved untouched job", next)
	}
	// Structured pages survive worker interruption; completion requires the whole
	// cursor chain and preserves API order across pages.
	pagedEntry := map[string]interface{}{"id": "paged-chat", "title": "Paged", "updated_at": "2026-10-09T18:00:00Z"}
	pagedDiscovery := map[string]interface{}{"scope": "paged", "conversations": []interface{}{pagedEntry}, "checkpoint": map[string]interface{}{"complete": false}}
	call("discover", pagedDiscovery, 200)
	// Discovered rows can be claimed before the first inventory finishes.
	pagedJob := call("claim", map[string]interface{}{"scope": "paged"}, 200)["job"].(map[string]interface{})
	pagedJob["scope"] = "paged"
	makePage := func(id, role, text string, more bool) map[string]interface{} {
		return map[string]interface{}{"conversation_id": "paged-chat", "messages": []interface{}{map[string]interface{}{"id": id, "author": map[string]interface{}{"role": role}, "content": map[string]interface{}{"content_type": "text", "parts": []string{text}}, "status": "finished_successfully"}}, "page_info": map[string]interface{}{"has_previous_page": more, "has_next_page": !more, "start_cursor": "older"}}
	}
	pagedJob["cursor"] = ""
	pagedJob["page"] = makePage("newer", "assistant", "Newer answer", true)
	pagedJob["page"].(map[string]interface{})["messages"].([]interface{})[0].(map[string]interface{})["status"] = "in_progress"
	call("page", pagedJob, 200)
	call("page", pagedJob, 200)
	if call("verify", pagedJob, 200)["matches"] != true {
		t.Fatal("unchanged head did not verify")
	}
	pagedJob["page"] = makePage("newer", "assistant", "Changed answer", true)
	if call("verify", pagedJob, 200)["matches"] != false {
		t.Fatal("changed head reused")
	}
	call("page", pagedJob, 400)
	call("complete", pagedJob, 400)
	progress := call("pages", pagedJob, 200)
	if progress["cursor"] != "older" || progress["pages"] != float64(1) || progress["complete"] != false {
		t.Fatal(progress)
	}
	call("yield", pagedJob, 200)
	resumed := call("claim", map[string]interface{}{"scope": "paged"}, 200)["job"].(map[string]interface{})
	resumed["scope"] = "paged"
	if call("pages", resumed, 200)["cursor"] != "older" {
		t.Fatal("lost page checkpoint")
	}
	call("page", pagedJob, 409)
	resumed["cursor"] = "older"
	resumed["page"] = makePage("older", "user", "Older question", false)
	call("page", resumed, 200)
	call("complete", resumed, 200)
	transcript, err := os.ReadFile(filepath.Join(root, "paged", "conversations", "paged-chat", "conversation.md"))
	if err != nil || strings.Index(string(transcript), "Older question") < 0 || strings.Index(string(transcript), "Older question") > strings.Index(string(transcript), "Newer answer") {
		t.Fatal(string(transcript), err)
	}
	if !strings.Contains(string(transcript), "Source message status: in_progress") {
		t.Fatal("unfinished source status was lost", string(transcript))
	}
	call("discover", pagedDiscovery, 200)
	if call("claim", map[string]interface{}{"scope": "paged"}, 200)["job"] != nil {
		t.Fatal("unchanged remote timestamp requeued")
	}
	pagedEntry["updated_at"] = "2026-10-09T18:00:00.000Z"
	call("discover", pagedDiscovery, 200)
	if call("claim", map[string]interface{}{"scope": "paged"}, 200)["job"] != nil {
		t.Fatal("timestamp formatting requeued saved content")
	}
	pagedEntry["updated_at"] = "2026-10-09T17:00:00Z"
	call("discover", pagedDiscovery, 200)
	var retainedTimestamp string
	db.Get(&retainedTimestamp, "SELECT remote_updated_at FROM chatgpt_conversations WHERE scope='paged'")
	if retainedTimestamp != "2026-10-09T18:00:00Z" || call("claim", map[string]interface{}{"scope": "paged"}, 200)["job"] != nil {
		t.Fatal("older inventory requeued saved content or lowered timestamp", retainedTimestamp)
	}
	pagedEntry["updated_at"] = "2026-10-09T19:00:00Z"
	call("discover", pagedDiscovery, 200)
	changed := call("claim", map[string]interface{}{"scope": "paged"}, 200)["job"].(map[string]interface{})
	changed["scope"] = "paged"
	if changed["generation"] != float64(2) || call("pages", changed, 200)["pages"] != float64(0) {
		t.Fatal("old revision pages reused", changed)
	}
	changed["error"] = "expired continuation"
	call("restart", changed, 200)
	var restarted int
	db.Get(&restarted, `SELECT generation FROM chatgpt_conversations WHERE scope='paged'`)
	if restarted != 3 {
		t.Fatal("continuation restart did not create a new generation", restarted)
	}
	retained, _ := os.ReadFile(filepath.Join(root, "paged", "conversations", "paged-chat", "conversation.md"))
	if string(retained) != string(transcript) {
		t.Fatal("restart overwrote last good backup")
	}
	for _, want := range []string{"chatgpt_backup claimed", "chatgpt_backup saving", "chatgpt_backup retry", "elapsed_ms=", "messages=2"} {
		if !strings.Contains(diagnostics.String(), want) {
			t.Fatalf("missing diagnostic %q", want)
		}
	}
	for _, private := range []string{"What is RAG?", "Retrieval with evidence.", claim["lease"].(string)} {
		if strings.Contains(diagnostics.String(), private) {
			t.Fatal("backup diagnostics exposed snapshot content or lease")
		}
	}
}

func TestChatGPTWriteRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "original")
	if err := os.WriteFile(target, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "conversation.md")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := chatGPTWrite(link, []byte("keep")); err == nil {
		t.Fatal("symlink accepted as unchanged backup")
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "keep" {
		t.Fatal(string(data), err)
	}
}
