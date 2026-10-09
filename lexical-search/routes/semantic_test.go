//go:build vectors

package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blevesearch/bleve/v2"
	"github.com/gin-gonic/gin"
	"lexical-search/archive"
	"lexical-search/config"
	"lexical-search/mapping"
	"lexical-search/server"
)

func TestSemanticMappingAndScopedFusion(t *testing.T) {
	m, _ := mapping.SlidingChunkMapping()
	path := filepath.Join(t.TempDir(), "index")
	index, err := bleve.New(path, m)
	if err != nil {
		t.Fatal(err)
	}
	// Migrate an existing lexical index, then close/reopen to verify persistence.
	if err := index.Index("old", map[string]interface{}{"text": "lexicalneedle", "path": "old"}); err != nil {
		t.Fatal(err)
	}
	if err := ensureEmbeddingMapping(index); err != nil {
		t.Fatal(err)
	}
	index.Close()
	index, err = bleve.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer index.Close()
	v := make([]float32, embeddingDimensions)
	v[0] = 1
	u := make([]float32, embeddingDimensions)
	u[1] = 1
	for id, vector := range map[string][]float32{"allowed": v, "excluded": v, "unrelated": u} {
		if err := index.Index(id, map[string]interface{}{"path": id, "text": "different passage", "embedding": vector, "embedding_model": "digest:retrieval-1"}); err != nil {
			t.Fatal(err)
		}
	}
	query := bleve.NewMatchQuery("lexicalneedle")
	query.SetField("text")
	request := bleve.NewSearchRequestOptions(query, 1, 0, false)
	request.Fields = []string{"path", "text"}
	hits, coverage, err := searchWithEmbeddings(context.Background(), index, request, []string{"allowed"}, v, "digest:retrieval-1")
	if err != nil {
		t.Fatal(err)
	}
	if coverage != 1 {
		t.Fatalf("coverage=%d", coverage)
	}
	for _, hit := range hits.Hits {
		if hit.ID == "excluded" {
			t.Fatal("out-of-scope vector leaked")
		}
	}
	// Pure semantic candidates can retrieve text with no query words.
	request = bleve.NewSearchRequestOptions(bleve.NewMatchNoneQuery(), 1, 0, false)
	request.Fields = []string{"text"}
	hits, _, err = searchWithEmbeddings(context.Background(), index, request, []string{"allowed", "unrelated"}, v, "digest:retrieval-1")
	if err != nil || len(hits.Hits) != 1 || hits.Hits[0].ID != "allowed" {
		t.Fatalf("semantic result=%+v error=%v", hits, err)
	}
	request = bleve.NewSearchRequestOptions(bleve.NewMatchNoneQuery(), 1, 0, false)
	hits, coverage, err = searchWithEmbeddings(context.Background(), index, request, []string{"allowed"}, v, "new-digest")
	if err != nil || coverage != 0 || len(hits.Hits) != 0 {
		t.Fatalf("stale model returned: %+v %d %v", hits, coverage, err)
	}
}

func TestSemanticBackfillAndConcurrentDeletion(t *testing.T) {
	oldDir, oldDB, oldRoots := config.LexDir, config.WorkspacesDBPath, config.IndexDirectories
	config.LexDir = filepath.Join(t.TempDir(), "indexes")
	config.WorkspacesDBPath = filepath.Join(config.LexDir, "workspaces.sqlite")
	root := t.TempDir()
	config.IndexDirectories = []string{root}
	t.Cleanup(func() { config.LexDir, config.WorkspacesDBPath, config.IndexDirectories = oldDir, oldDB, oldRoots })
	file := filepath.Join(root, "sample.txt")
	os.WriteFile(file, []byte("Passage about pricing power."), 0600)
	reconcileDirectories(context.Background(), config.IndexDirectories)
	workspaces, err := archive.GetWorkspaces(server.ListWorkspacesParams{})
	if err != nil || len(workspaces) != 1 {
		t.Fatalf("workspaces=%v %v", workspaces, err)
	}
	deleteDuringInference := false
	rejectInference := false
	calls := 0
	model := "test-digest"
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/tags" {
			fmt.Fprintf(w, `{"models":[{"name":"embeddinggemma:300m","digest":%q}]}`, model)
			return
		}
		var input struct {
			Input    []string `json:"input"`
			Truncate bool     `json:"truncate"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if input.Truncate {
			t.Error("silent truncation enabled")
		}
		calls++
		if rejectInference {
			w.WriteHeader(503)
			return
		}
		if deleteDuringInference {
			os.Remove(file)
			reconcileDirectories(context.Background(), config.IndexDirectories)
		}
		vectors := make([][]float32, len(input.Input))
		for i := range vectors {
			vectors[i] = make([]float32, embeddingDimensions)
			vectors[i][0] = 1
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"embeddings": vectors})
	}))
	defer api.Close()
	oldURL := embeddingURL
	embeddingURL = api.URL
	t.Cleanup(func() { embeddingURL = oldURL })
	identity, err := embeddingIdentity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	after := ""
	if err := backfillEmbeddings(context.Background(), workspaces[0], identity, &after); err != nil {
		t.Fatal(err)
	}
	if err := backfillEmbeddings(context.Background(), workspaces[0], identity, &after); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("unchanged chunks re-embedded %d times", calls)
	}
	t.Setenv("ARCHIVE_EMBEDDINGS", "1")
	router := gin.New()
	RegisterRetrievalHandlers(router)
	request := func(query string) map[string]interface{} {
		t.Helper()
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest("POST", "/api/v1/archive/search", strings.NewReader(fmt.Sprintf(`{"query":%q}`, query))))
		if response.Code != 200 {
			t.Fatalf("search status=%d body=%s", response.Code, response.Body.String())
		}
		var result map[string]interface{}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	result := request("unshared query words")
	if result["semantic_status"] != "ready" || len(result["results"].([]interface{})) != 1 {
		t.Fatalf("hybrid alias search failed: %+v", result)
	}
	rejectInference = true
	result = request("pricing power")
	if result["semantic_status"] != "unavailable" || len(result["results"].([]interface{})) != 1 {
		t.Fatalf("lexical fallback failed: %+v", result)
	}
	rejectInference = false
	model = "changed-digest"
	identity, _ = embeddingIdentity(context.Background())
	deleteDuringInference = true
	if err := backfillEmbeddings(context.Background(), workspaces[0], identity, &after); err != nil {
		t.Fatal(err)
	}
	index, err := bleve.Open(workspaces[0].BleveDir)
	if err != nil {
		t.Fatal(err)
	}
	defer index.Close()
	count, _ := index.DocCount()
	if count != 0 {
		t.Fatalf("deleted chunk resurrected: %d", count)
	}
}

func TestLocalEmbeddingSmoke(t *testing.T) {
	if os.Getenv("SEMANTIC_LIVE_TEST") != "1" {
		t.Skip("set SEMANTIC_LIVE_TEST=1 with the isolated Ollama server running")
	}
	t.Setenv("ARCHIVE_EMBEDDINGS", "1")
	query, model, err := prepareEmbeddingQuery(context.Background(), "companies passing higher costs to customers")
	if err != nil {
		t.Fatal(err)
	}
	vectors, err := embedTexts(context.Background(), []string{"title: Business | text: The firm demonstrated pricing power by raising prices to protect margins.", "title: Nature | text: A bird built a nest in a tree."})
	if err != nil {
		t.Fatal(err)
	}
	dot := func(a, b []float32) float64 {
		var sum float64
		for i := range a {
			sum += float64(a[i]) * float64(b[i])
		}
		return sum
	}
	related, unrelated := dot(query, vectors[0]), dot(query, vectors[1])
	t.Logf("model=%s dims=%d related=%f unrelated=%f", model, len(query), related, unrelated)
	if related <= unrelated {
		t.Fatal("paraphrase did not outrank unrelated text")
	}
	// Exercise the same actual FAISS retrieval path with these local vectors.
	m, _ := mapping.SlidingChunkMapping()
	index, err := bleve.New(filepath.Join(t.TempDir(), "live"), m)
	if err != nil {
		t.Fatal(err)
	}
	defer index.Close()
	if err := ensureEmbeddingMapping(index); err != nil {
		t.Fatal(err)
	}
	for i, v := range vectors {
		index.Index(fmt.Sprint(i), map[string]interface{}{"text": strings.Repeat("sample ", i+1), "embedding": v, "embedding_model": model})
	}
	request := bleve.NewSearchRequestOptions(bleve.NewMatchNoneQuery(), 1, 0, false)
	hits, _, err := searchWithEmbeddings(context.Background(), index, request, []string{"0", "1"}, query, model)
	if err != nil || len(hits.Hits) != 1 || hits.Hits[0].ID != "0" {
		t.Fatalf("live FAISS retrieval failed: %+v %v", hits, err)
	}
}
