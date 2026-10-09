//go:build vectors

package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blevesearch/bleve/v2"
	faiss "github.com/blevesearch/go-faiss"
	"github.com/gin-gonic/gin"
	"lexical-search/archive"
	"lexical-search/config"
	"lexical-search/mapping"
)

func semanticAPI(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	server := httptest.NewServer(handler)
	old := embeddingURL
	embeddingURL = server.URL
	t.Cleanup(func() { embeddingURL = old; server.Close() })
}

func semanticVector(axis int) []float32 {
	vector := make([]float32, embeddingDimensions)
	vector[axis] = 1
	return vector
}

func semanticFixtures(t *testing.T, sources ...map[string]string) []archive.WorkspaceRecord {
	t.Helper()
	oldDir, oldDB, oldRoots := config.LexDir, config.WorkspacesDBPath, config.IndexDirectories
	config.LexDir = filepath.Join(t.TempDir(), "indexes")
	config.WorkspacesDBPath = filepath.Join(config.LexDir, "workspaces.sqlite")
	config.IndexDirectories = nil
	t.Cleanup(func() { config.LexDir, config.WorkspacesDBPath, config.IndexDirectories = oldDir, oldDB, oldRoots })
	for _, files := range sources {
		root := t.TempDir()
		config.IndexDirectories = append(config.IndexDirectories, root)
		for path, text := range files {
			full := filepath.Join(root, path)
			if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, []byte(text), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	reconcileDirectories(context.Background(), config.IndexDirectories)
	return mustWorkspaces(t)
}

func semanticIndex(t *testing.T) bleve.Index {
	t.Helper()
	mapping, err := mapping.SlidingChunkMapping()
	if err != nil {
		t.Fatal(err)
	}
	index, err := bleve.New(filepath.Join(t.TempDir(), "index"), mapping)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { index.Close() })
	if err := ensureEmbeddingMapping(index); err != nil {
		t.Fatal(err)
	}
	return index
}

func semanticInsert(t *testing.T, index bleve.Index, id, text, model string, vector []float32) {
	t.Helper()
	doc := map[string]interface{}{"text": text, "path": id, "lineStart": "1", "lineEnd": "1"}
	if vector != nil {
		doc["embedding"], doc["embedding_model"] = vector, model
	}
	if err := index.Index(id, doc); err != nil {
		t.Fatal(err)
	}
}

func TestHybridRankingDeduplicationAndTies(t *testing.T) {
	index := semanticIndex(t)
	semanticInsert(t, index, "a-lexical", "preciseneedle", "", nil)
	// The overlapping passage ranks second in each individual list.
	vector := semanticVector(0)
	vector[0] = 0.5
	vector[1] = float32(math.Sqrt(0.75))
	semanticInsert(t, index, "both", "preciseneedle "+strings.Repeat("unrelated ", 100), "model", vector)
	semanticInsert(t, index, "z-semantic", "totally different words", "model", semanticVector(0))
	semanticInsert(t, index, "excluded", "preciseneedle", "model", semanticVector(0))
	ids := []string{"a-lexical", "both", "z-semantic"}
	match := bleve.NewMatchQuery("preciseneedle")
	match.SetField("text")
	query := bleve.NewConjunctionQuery(match, bleve.NewDocIDQuery(ids))
	lexical, err := index.Search(bleve.NewSearchRequest(query))
	if err != nil {
		t.Fatal(err)
	}
	if len(lexical.Hits) != 2 || lexical.Hits[0].ID != "a-lexical" || lexical.Hits[1].ID != "both" {
		t.Fatalf("unexpected fixture lexical order: %+v", lexical.Hits)
	}
	for repeat := 0; repeat < 5; repeat++ {
		request := bleve.NewSearchRequestOptions(query, 3, 0, false)
		request.SortBy([]string{"-_score", "_id"})
		result, coverage, err := searchWithEmbeddings(context.Background(), index, request, ids, semanticVector(0), "model")
		if err != nil {
			t.Fatal(err)
		}
		got := []string{}
		for _, hit := range result.Hits {
			got = append(got, hit.ID)
		}
		if !reflect.DeepEqual(got, []string{"both", "a-lexical", "z-semantic"}) {
			t.Fatalf("combined ranking, deduplication, or tie order: %v", got)
		}
		if coverage != 2 {
			t.Fatalf("coverage=%d", coverage)
		}
		for i, want := range []float64{2.0 / 62, 1.0 / 61, 1.0 / 61} {
			if math.Abs(result.Hits[i].Score-want) > 1e-12 {
				t.Fatalf("score[%d]=%g want %g", i, result.Hits[i].Score, want)
			}
		}
	}
	request := bleve.NewSearchRequestOptions(query, 1, 0, false)
	result, _, err := searchWithEmbeddings(context.Background(), index, request, ids, semanticVector(0), "model")
	if err != nil || len(result.Hits) != 1 || result.Hits[0].ID != "both" {
		t.Fatalf("limit not applied after fusion: %+v %v", result, err)
	}
	// No current embeddings must preserve lexical scores, not apply fusion.
	request = bleve.NewSearchRequestOptions(query, 1, 0, false)
	result, coverage, err := searchWithEmbeddings(context.Background(), index, request, ids, semanticVector(0), "missing-model")
	if err != nil || coverage != 0 || len(result.Hits) != 1 || result.Hits[0].Score != lexical.Hits[0].Score {
		t.Fatalf("zero-coverage lexical behavior changed: %+v %v", result, err)
	}
}

func TestEmbeddingResponseValidation(t *testing.T) {
	valid, _ := json.Marshal(map[string]interface{}{"embeddings": [][]float32{semanticVector(0)}})
	zero, _ := json.Marshal(map[string]interface{}{"embeddings": [][]float32{make([]float32, embeddingDimensions)}})
	oversized := strings.Repeat(" ", 4<<20) + string(valid)
	for _, test := range []struct {
		name, body string
		status     int
		wantError  bool
	}{
		{"valid", string(valid), 200, false},
		{"wrong-count", `{"embeddings":[]}`, 200, true},
		{"wrong-dimensions", `{"embeddings":[[1,2]]}`, 200, true},
		{"zero-vector", string(zero), 200, true},
		{"null-vector", `{"embeddings":[null]}`, 200, true},
		{"overflow", `{"embeddings":[[1e100]]}`, 200, true},
		{"nonfinite-json", `{"embeddings":[[NaN]]}`, 200, true},
		{"malformed", `{`, 200, true},
		{"oversized-response", oversized, 200, true},
		{"bad-input", "", 400, true},
		{"unavailable", "", 503, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			semanticAPI(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/api/embed" {
					t.Errorf("wrong request: %s %s", r.Method, r.URL.Path)
				}
				var input map[string]interface{}
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Error(err)
				}
				if input["truncate"] != false || input["model"] != embeddingModel || input["dimensions"] != float64(embeddingDimensions) {
					t.Errorf("unsafe embedding parameters: %v", input)
				}
				w.WriteHeader(test.status)
				w.Write([]byte(test.body))
			})
			vectors, err := embedTexts(context.Background(), []string{"text"})
			if (err != nil) != test.wantError {
				t.Fatalf("vectors=%v error=%v", vectors, err)
			}
			if test.status == 400 && !errors.Is(err, errEmbeddingInput) {
				t.Fatalf("missing input-error classification: %v", err)
			}
			if !test.wantError && !reflect.DeepEqual(vectors[0], semanticVector(0)) {
				t.Fatal("vector changed")
			}
		})
	}
}

func TestEmbeddingTransportAndIdentityFailures(t *testing.T) {
	t.Run("redirect-rejected", func(t *testing.T) {
		var forwarded atomic.Int32
		destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1) }))
		defer destination.Close()
		semanticAPI(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) })
		if _, err := embedTexts(context.Background(), []string{"private passage"}); err == nil {
			t.Fatal("redirect accepted")
		}
		if forwarded.Load() != 0 {
			t.Fatal("passage forwarded outside configured endpoint")
		}
	})
	t.Run("deadline", func(t *testing.T) {
		release := make(chan struct{})
		semanticAPI(t, func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-r.Context().Done():
			case <-release:
			}
		})
		t.Cleanup(func() { close(release) })
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		if _, err := embedTexts(ctx, []string{"text"}); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("deadline not propagated: %v", err)
		}
	})
	t.Run("connection-refused", func(t *testing.T) {
		server := httptest.NewServer(http.NotFoundHandler())
		url := server.URL
		server.Close()
		old := embeddingURL
		embeddingURL = url
		defer func() { embeddingURL = old }()
		if _, err := embeddingIdentity(context.Background()); err == nil {
			t.Fatal("missing server accepted")
		}
	})
	for _, body := range []string{`{"models":[]}`, `{"models":[{"name":"other","digest":"x"}]}`, `{"models":[{"name":"embeddinggemma:300m","digest":""}]}`, `{`} {
		t.Run("missing-or-invalid-model", func(t *testing.T) {
			semanticAPI(t, func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) })
			if _, err := embeddingIdentity(context.Background()); err == nil {
				t.Fatal("invalid model identity accepted")
			}
		})
	}
	t.Run("disabled-does-not-call-server", func(t *testing.T) {
		t.Setenv("ARCHIVE_EMBEDDINGS", "")
		semanticAPI(t, func(w http.ResponseWriter, r *http.Request) { t.Error("disabled inference made HTTP request") })
		vector, model, err := prepareEmbeddingQuery(context.Background(), "text")
		if err != nil || vector != nil || model != "" {
			t.Fatalf("disabled result: %v %q %v", vector, model, err)
		}
	})
	t.Run("model-changes-during-query", func(t *testing.T) {
		t.Setenv("ARCHIVE_EMBEDDINGS", "1")
		var tags atomic.Int32
		semanticAPI(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/tags" {
				fmt.Fprintf(w, `{"models":[{"name":%q,"digest":"digest-%d"}]}`, embeddingModel, tags.Add(1))
				return
			}
			var input struct {
				Input []string `json:"input"`
			}
			json.NewDecoder(r.Body).Decode(&input)
			if !reflect.DeepEqual(input.Input, []string{"task: search result | query: question"}) {
				t.Errorf("wrong query format: %v", input.Input)
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"embeddings": [][]float32{semanticVector(0)}})
		})
		if vector, _, err := prepareEmbeddingQuery(context.Background(), "question"); err == nil || vector != nil {
			t.Fatalf("mixed model query accepted: %v %v", vector, err)
		}
	})
}

func TestHybridMultipleWorkspacesPartialCoverageAndLogs(t *testing.T) {
	workspaces := semanticFixtures(t, map[string]string{"embedded.txt": "first original text", "pending.txt": "lexicalpending target"}, map[string]string{"other.txt": "second original text"})
	t.Setenv("ARCHIVE_EMBEDDINGS", "1")
	for _, workspace := range workspaces {
		records, err := fileChunks(workspace)
		if err != nil {
			t.Fatal(err)
		}
		index, err := bleve.Open(workspace.BleveDir)
		if err != nil {
			t.Fatal(err)
		}
		if err := ensureEmbeddingMapping(index); err != nil {
			t.Fatal(err)
		}
		for _, record := range records {
			if record.Path == "pending.txt" {
				continue
			}
			request := bleve.NewSearchRequest(bleve.NewDocIDQuery([]string{record.Id.String()}))
			request.Fields = []string{"path", "text", "lineStart", "lineEnd"}
			hits, err := index.Search(request)
			if err != nil || len(hits.Hits) != 1 {
				t.Fatalf("fixture chunk missing: %v", err)
			}
			doc := hits.Hits[0].Fields
			doc["embedding"], doc["embedding_model"] = semanticVector(0), "digest:retrieval-1"
			if err := index.Index(record.Id.String(), doc); err != nil {
				t.Fatal(err)
			}
		}
		index.Close()
	}
	semanticAPI(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/tags" {
			fmt.Fprintf(w, `{"models":[{"name":%q,"digest":"digest"}]}`, embeddingModel)
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"embeddings": [][]float32{semanticVector(0)}})
	})
	router := gin.New()
	RegisterRetrievalHandlers(router)
	search := func(scope []string, wantStatus string, wantCoverage, wantResults int) []map[string]interface{} {
		t.Helper()
		body, _ := json.Marshal(map[string]interface{}{"query": "lexicalpending target", "corpus_ids": scope, "limit": 10})
		response := httptest.NewRecorder()
		var captured bytes.Buffer
		old := log.Writer()
		log.SetOutput(&captured)
		router.ServeHTTP(response, httptest.NewRequest("POST", "/api/v1/archive/search", bytes.NewReader(body)))
		log.SetOutput(old)
		if response.Code != 200 {
			t.Fatalf("search: %d %s", response.Code, response.Body.String())
		}
		var result struct {
			Results  []map[string]interface{} `json:"results"`
			Status   string                   `json:"semantic_status"`
			Coverage int                      `json:"semantic_indexed_passages"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Status != wantStatus || result.Coverage != wantCoverage || len(result.Results) != wantResults {
			t.Fatalf("unexpected response: %s", response.Body.String())
		}
		var entry map[string]interface{}
		for _, line := range strings.Split(captured.String(), "\n") {
			if start := strings.Index(line, "{"); start >= 0 {
				var data map[string]interface{}
				if json.Unmarshal([]byte(line[start:]), &data) == nil && data["event"] == "archive_search" {
					entry = data
				}
			}
		}
		if entry == nil || entry["semantic_status"] != wantStatus {
			t.Fatalf("missing/truthless search log: %s", captured.String())
		}
		if wantCoverage > 0 {
			if entry["total_matches"] != nil || entry["lexical_total_matches"] != float64(1) {
				t.Fatalf("hybrid totals misreported: %v", entry)
			}
		}
		for _, hit := range result.Results {
			if hit["text"] == nil || hit["document_id"] == nil || hit["line_start"] != float64(1) || hit["url"] == nil {
				t.Fatalf("source provenance lost: %v", hit)
			}
		}
		return result.Results
	}
	all := search(nil, "partial", 2, 3)
	seen := map[string]bool{}
	for _, hit := range all {
		id := hit["chunk_id"].(string)
		if seen[id] {
			t.Fatal("duplicate chunk across workspaces")
		}
		seen[id] = true
	}
	first := search([]string{archiveID(workspaces[0], ".")}, "partial", 1, 2)
	for _, hit := range first {
		if strings.Contains(hit["text"].(string), "second original") {
			t.Fatal("cross-workspace scope leak")
		}
	}
	// Empty current-vector coverage reports partial and retains the pending lexical hit.
	search([]string{archiveID(workspaces[0], "pending.txt")}, "partial", 0, 1)
	// Exercise a real Bleve vector-query failure without damaging the index.
	// The lexical request remains valid when the kNN candidate count is rejected.
	oldMaxK := bleve.BleveMaxK
	bleve.BleveMaxK = 1
	t.Cleanup(func() { bleve.BleveMaxK = oldMaxK })
	search(nil, "unavailable", 0, 1)
}

// Empty exclusions occur when every vector in an IVF segment is eligible.
// The original pinned binding panics in a dependency goroutine here.
func TestEmptyFAISSSelectors(t *testing.T) {
	for _, create := range []func([]int64) (faiss.Selector, error){faiss.NewIDSelectorBatch, faiss.NewIDSelectorNot} {
		selector, err := create(nil)
		if err != nil {
			t.Fatal(err)
		}
		selector.Delete()
	}
}

func TestSlowEmbeddingReturnsLexicalWithinBudget(t *testing.T) {
	t.Setenv("ARCHIVE_EMBEDDINGS", "1")
	semanticFixtures(t, map[string]string{"passage.txt": "lexicalneedle remains available"})
	finished := make(chan struct{})
	semanticAPI(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/tags" {
			fmt.Fprintf(w, `{"models":[{"name":%q,"digest":"digest"}]}`, embeddingModel)
			return
		}
		io.Copy(io.Discard, r.Body)
		defer close(finished)
		<-r.Context().Done()
	})
	router := gin.New()
	RegisterRetrievalHandlers(router)
	started := time.Now()
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest("POST", "/api/v1/archive/search", strings.NewReader(`{"query":"lexicalneedle","limit":1}`)))
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("slow inference delayed lexical response: %s", elapsed)
	}
	var result struct {
		Results []map[string]interface{} `json:"results"`
		Status  string                   `json:"semantic_status"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || result.Status != "unavailable" || len(result.Results) != 1 {
		t.Fatalf("lost lexical fallback: %s", response.Body.String())
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("inference request was not cancelled")
	}
}

func TestVectorPanicFallsBackAndSemanticSurvivesWithoutLexical(t *testing.T) {
	request := bleve.NewSearchRequestOptions(bleve.NewMatchAllQuery(), 1, 0, false)
	result, coverage, err := searchEmbeddingCandidates(context.Background(), nil, request, []string{"one"}, semanticVector(0), "digest")
	if err == nil || result != nil || coverage != 0 {
		t.Fatalf("panic was not converted to failure: %v %d %v", result, coverage, err)
	}
	index := semanticIndex(t)
	semanticInsert(t, index, "one", "usable semantic passage", "digest", semanticVector(0))
	result, coverage, err = searchEmbeddingCandidates(context.Background(), index, request, []string{"one"}, semanticVector(0), "digest")
	if err != nil || coverage != 1 {
		t.Fatalf("semantic result lost: %v", err)
	}
	merged := mergeSearchResults(nil, result, 1)
	if len(merged.Hits) != 1 || merged.Hits[0].ID != "one" {
		t.Fatalf("no surviving result: %+v", merged)
	}
}
