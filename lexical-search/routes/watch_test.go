package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"lexical-search/config"
	"lexical-search/server"
)

func TestAutomaticIndexing(t *testing.T) {
	for _, mode := range []string{"events", "polling"} {
		t.Run(mode, func(t *testing.T) {
			oldDir, oldDB := config.LexDir, config.WorkspacesDBPath
			config.LexDir = filepath.Join(t.TempDir(), "indexes")
			config.WorkspacesDBPath = filepath.Join(config.LexDir, "workspaces.sqlite")
			root := filepath.Join(t.TempDir(), "source")
			interval := time.Hour
			if mode == "events" {
				if err := os.MkdirAll(root, 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				interval = 50 * time.Millisecond
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				defer close(done)
				if mode == "polling" {
					watchDirectories(ctx, []string{root}, interval, nil)
				} else {
					WatchDirectories(ctx, []string{root}, interval)
				}
			}()
			t.Cleanup(func() {
				cancel()
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Error("indexer did not stop")
				}
				config.LexDir, config.WorkspacesDBPath = oldDir, oldDB
			})
			gin.SetMode(gin.TestMode)
			router := gin.New()
			server.RegisterHandlersWithOptions(router, &Api{}, server.GinServerOptions{BaseURL: "/api/v1"})
			wait := func(check func() bool) {
				t.Helper()
				deadline := time.Now().Add(6 * time.Second)
				for time.Now().Before(deadline) {
					if check() {
						return
					}
					time.Sleep(25 * time.Millisecond)
				}
				t.Fatal("automatic index update timed out")
			}
			var id string
			findWorkspace := func() bool {
				res := httptest.NewRecorder()
				router.ServeHTTP(res, httptest.NewRequest("GET", "/api/v1/workspaces", nil))
				var body server.WorkspacesResponse
				if res.Code != 200 || json.Unmarshal(res.Body.Bytes(), &body) != nil || len(body.Workspaces) == 0 {
					return false
				}
				if body.Workspaces[0].BleveDir == "" {
					return false
				}
				id = body.Workspaces[0].Id.String()
				return true
			}
			if mode == "events" {
				wait(findWorkspace)
			} else {
				time.Sleep(150 * time.Millisecond)
			} // Empty roots initialize successfully.
			if err := os.MkdirAll(filepath.Join(root, "nested"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Join(root, "nested", ".git"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "ignored.json"), []byte("forbiddenbinary"), 0600); err != nil {
				t.Fatal(err)
			}
			article := filepath.Join(root, "nested", "article é.md")
			write := func(text string) {
				t.Helper()
				if err := os.WriteFile(article, []byte(text+"\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			write("Distinctive marmalade observations")
			wait(findWorkspace)
			count := func(query string) int {
				data, _ := json.Marshal(server.SearchRequest{Id: id, Query: query, Limit: 10, Databases: []server.MontyDatabase{}})
				res := httptest.NewRecorder()
				req := httptest.NewRequest("POST", "/api/v1/search", strings.NewReader(string(data)))
				req.Header.Set("Content-Type", "application/json")
				router.ServeHTTP(res, req)
				var body server.SearchResponse
				if res.Code != 200 || json.Unmarshal(res.Body.Bytes(), &body) != nil {
					return -1
				}
				return len(body.Results)
			}
			wait(func() bool { return count("marmalade") == 1 })
			if count("forbiddenbinary") != 0 {
				t.Fatal("non-text format was indexed")
			}
			if mode == "polling" {
				unavailable := root + "-disconnected"
				if err := os.Rename(root, unavailable); err != nil {
					t.Fatal(err)
				}
				time.Sleep(200 * time.Millisecond)
				if count("marmalade") != 1 {
					t.Fatal("unavailable root lost its index")
				}
				if err := os.Rename(unavailable, root); err != nil {
					t.Fatal(err)
				}
			}

			if mode == "events" {
				write("Distinctive telescope observations")
				wait(func() bool { return count("telescope") == 1 && count("marmalade") == 0 })
				renamed := filepath.Join(root, "nested", "renamed.md")
				if err := os.Rename(article, renamed); err != nil {
					t.Fatal(err)
				}
				wait(func() bool {
					data, _ := json.Marshal(server.SearchRequest{Id: id, Query: "telescope", Limit: 10})
					res := httptest.NewRecorder()
					req := httptest.NewRequest("POST", "/api/v1/search", strings.NewReader(string(data)))
					req.Header.Set("Content-Type", "application/json")
					router.ServeHTTP(res, req)
					var body server.SearchResponse
					json.Unmarshal(res.Body.Bytes(), &body)
					return res.Code == 200 && len(body.Results) == 1 && strings.HasSuffix(body.Results[0].Document.Path, "renamed.md")
				})
				article = renamed
			}
			if err := os.Remove(article); err != nil {
				t.Fatal(err)
			}
			query := "marmalade"
			if mode == "events" {
				query = "telescope"
			}
			wait(func() bool { return count(query) == 0 })
		})
	}
}
