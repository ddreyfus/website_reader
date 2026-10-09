//go:build vectors

package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blevesearch/bleve/v2"
	"lexical-search/archive"
	"lexical-search/config"
)

func TestBackfillBatchFailureProgressAndRestart(t *testing.T) {
	files := map[string]string{}
	for i := 0; i < 20; i++ {
		files[fmt.Sprintf("%02d.txt", i)] = fmt.Sprintf("passage number %02d", i)
	}
	workspace := semanticFixtures(t, files)[0]
	records, err := fileChunks(workspace)
	if err != nil {
		t.Fatal(err)
	}
	// Pick the first chunk in ID order so its failure exercises pagination.
	index, err := bleve.Open(workspace.BleveDir)
	if err != nil {
		t.Fatal(err)
	}
	request := bleve.NewSearchRequestOptions(bleve.NewMatchAllQuery(), 1, 0, false)
	request.SortBy([]string{"_id"})
	request.Fields = []string{"text"}
	hits, err := index.Search(request)
	index.Close()
	if err != nil {
		t.Fatal(err)
	}
	badText := hits.Hits[0].Fields["text"].(string)
	rejectBad := true
	maxBatch := 0
	calls := 0
	semanticAPI(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/tags" {
			fmt.Fprintf(w, `{"models":[{"name":%q,"digest":"digest"}]}`, embeddingModel)
			return
		}
		var body struct {
			Input    []string `json:"input"`
			Truncate bool     `json:"truncate"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		calls++
		if len(body.Input) > maxBatch {
			maxBatch = len(body.Input)
		}
		for _, text := range body.Input {
			if rejectBad && strings.Contains(text, badText) {
				w.WriteHeader(400)
				return
			}
		}
		vectors := make([][]float32, len(body.Input))
		for i := range vectors {
			vectors[i] = semanticVector(0)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"embeddings": vectors})
	})
	model := "digest:retrieval-1"
	after := ""
	for i := 0; i < 3; i++ {
		if err := backfillEmbeddings(context.Background(), workspace, model, &after); err != nil {
			t.Fatal(err)
		}
	}
	count := func() uint64 {
		t.Helper()
		index, err := bleve.Open(workspace.BleveDir)
		if err != nil {
			t.Fatal(err)
		}
		defer index.Close()
		result, err := index.Search(bleve.NewSearchRequest(modelQuery(model)))
		if err != nil {
			t.Fatal(err)
		}
		return result.Total
	}
	if count() != 19 || maxBatch != 16 || after != "" {
		t.Fatalf("failed chunk blocked progress: indexed=%d maxBatch=%d cursor=%q records=%d", count(), maxBatch, after, len(records))
	}
	// Simulate a process restart: no in-memory cursor survives. Only the failed
	// chunk should be retried, and successfully indexed text must not be repeated.
	rejectBad = false
	after = ""
	before := calls
	if err := backfillEmbeddings(context.Background(), workspace, model, &after); err != nil {
		t.Fatal(err)
	}
	if count() != 20 || calls != before+1 {
		t.Fatalf("restart recovery repeated/skipped work: count=%d calls=%d", count(), calls-before)
	}
	before = calls
	if err := backfillEmbeddings(context.Background(), workspace, model, &after); err != nil {
		t.Fatal(err)
	}
	if calls != before {
		t.Fatal("completed backfill made inference calls")
	}
}

func TestBackfillRejectsChangedContentAndModels(t *testing.T) {
	for _, scenario := range []string{"edit", "model-change", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			workspace := semanticFixtures(t, map[string]string{"sample.txt": "original source passage"})[0]
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			triggered := false
			semanticAPI(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/tags" {
					digest := "digest"
					if triggered && scenario == "model-change" {
						digest = "new-digest"
					}
					fmt.Fprintf(w, `{"models":[{"name":%q,"digest":%q}]}`, embeddingModel, digest)
					return
				}
				if !triggered {
					triggered = true
					switch scenario {
					case "edit":
						if err := os.WriteFile(filepath.Join(workspace.WorkTree, "sample.txt"), []byte("updated source passage"), 0600); err != nil {
							t.Error(err)
						}
						reconcileDirectories(context.Background(), config.IndexDirectories)
					case "cancel":
						cancel()
					}
				}
				json.NewEncoder(w).Encode(map[string]interface{}{"embeddings": [][]float32{semanticVector(0)}})
			})
			after := ""
			err := backfillEmbeddings(ctx, workspace, "digest:retrieval-1", &after)
			if scenario == "model-change" && (err == nil || !strings.Contains(err.Error(), "model changed")) {
				t.Fatalf("model change accepted: %v", err)
			}
			if scenario == "cancel" && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation not propagated: %v", err)
			}
			if scenario == "edit" && err != nil {
				t.Fatal(err)
			}
			index, err := bleve.Open(workspace.BleveDir)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if index != nil {
					index.Close()
				}
			}()
			result, err := index.Search(bleve.NewSearchRequest(modelQuery("digest:retrieval-1")))
			if err != nil {
				t.Fatal(err)
			}
			if result.Total != 0 {
				t.Fatalf("stale/interrupted embeddings published: %d", result.Total)
			}
			request := bleve.NewSearchRequest(bleve.NewMatchAllQuery())
			request.Fields = []string{"text"}
			result, err = index.Search(request)
			if err != nil || result.Total != 1 {
				t.Fatalf("source lost: %v %v", result, err)
			}
			if scenario == "edit" && result.Hits[0].Fields["text"] != "updated source passage" {
				t.Fatal("old source resurrected")
			}
			index.Close()
			index = nil
			// A fresh process has no cursor or cancellation state. It must finish
			// the current source/model without duplicating the aborted version.
			after = ""
			model := "digest:retrieval-1"
			if scenario == "model-change" {
				model = "new-digest:retrieval-1"
			}
			if err := backfillEmbeddings(context.Background(), workspace, model, &after); err != nil {
				t.Fatal(err)
			}
			resumed, err := bleve.Open(workspace.BleveDir)
			if err != nil {
				t.Fatal(err)
			}
			defer resumed.Close()
			current, err := resumed.Search(bleve.NewSearchRequest(modelQuery(model)))
			if err != nil || current.Total != 1 {
				t.Fatalf("current version not recovered: %+v %v", current, err)
			}
		})
	}
}

func TestBackfillServiceFailureDoesNotRetryEveryPassage(t *testing.T) {
	workspace := semanticFixtures(t, map[string]string{"a.txt": "one", "b.txt": "two"})[0]
	calls := 0
	semanticAPI(t, func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(503) })
	after := ""
	if err := backfillEmbeddings(context.Background(), workspace, "digest:retrieval-1", &after); err == nil {
		t.Fatal("service failure hidden")
	}
	if calls != 1 {
		t.Fatalf("outage triggered per-passage retries: %d", calls)
	}
}

func TestEmbeddingWorkerShutdown(t *testing.T) {
	for _, scenario := range []string{"disabled", "identity-failure-backoff", "inference-in-flight"} {
		t.Run(scenario, func(t *testing.T) {
			t.Setenv("ARCHIVE_EMBEDDINGS", "1")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			entered := make(chan struct{}, 1)
			var calls atomic.Int32
			if scenario == "inference-in-flight" {
				semanticFixtures(t, map[string]string{"a.txt": "passage"})
			}
			semanticAPI(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if scenario == "identity-failure-backoff" {
					w.WriteHeader(503)
					select {
					case entered <- struct{}{}:
					default:
					}
					return
				}
				if r.URL.Path == "/api/tags" {
					fmt.Fprintf(w, `{"models":[{"name":%q,"digest":"digest"}]}`, embeddingModel)
					return
				}
				select {
				case entered <- struct{}{}:
				default:
				}
				select {
				case <-r.Context().Done():
				case <-ctx.Done():
				}
			})
			if scenario == "disabled" {
				t.Setenv("ARCHIVE_EMBEDDINGS", "")
			}
			done := make(chan struct{})
			go func() { defer close(done); WatchEmbeddings(ctx) }()
			if scenario != "disabled" {
				select {
				case <-entered:
				case <-time.After(3 * time.Second):
					t.Fatal("worker did not enter expected phase")
				}
			}
			cancel()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("worker did not stop after cancellation")
			}
			if scenario == "disabled" && calls.Load() != 0 {
				t.Fatal("disabled worker contacted runtime")
			}
		})
	}
}

func TestEmbeddingWorkerCompletesBackfill(t *testing.T) {
	workspace := semanticFixtures(t, map[string]string{"sample.txt": "worker passage"})[0]
	t.Setenv("ARCHIVE_EMBEDDINGS", "1")
	var calls atomic.Int32
	semanticAPI(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/tags" {
			fmt.Fprintf(w, `{"models":[{"name":%q,"digest":"digest"}]}`, embeddingModel)
			return
		}
		calls.Add(1)
		json.NewEncoder(w).Encode(map[string]interface{}{"embeddings": [][]float32{semanticVector(0)}})
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { WatchEmbeddings(ctx); close(done) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("worker leaked")
		}
	})
	deadline := time.After(3 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	target := uint64(1)
	for {
		select {
		case <-deadline:
			t.Fatal("worker failed to publish embeddings")
		case <-ticker.C:
		}
		mutex := archive.GetWorkspaceMutex(workspace.WorkTree)
		mutex.Lock()
		index, err := bleve.Open(workspace.BleveDir)
		if err != nil {
			mutex.Unlock()
			t.Fatal(err)
		}
		result, err := index.Search(bleve.NewSearchRequest(modelQuery("digest:retrieval-1")))
		index.Close()
		mutex.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		if result.Total == target {
			if target == 2 {
				break
			}
			// A later directory sync must be picked up without restarting the
			// worker or invoking a separate backfill command.
			if err := os.WriteFile(filepath.Join(workspace.WorkTree, "later.txt"), []byte("newly synced passage"), 0600); err != nil {
				t.Fatal(err)
			}
			reconcileDirectories(context.Background(), config.IndexDirectories)
			target = 2
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("unexpected inference calls: %d", calls.Load())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("completed worker did not stop")
	}
}
