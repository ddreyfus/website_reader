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
	"os"
	"reflect"
	"time"

	"github.com/blevesearch/bleve/v2"
	blevemapping "github.com/blevesearch/bleve/v2/mapping"
	blevequery "github.com/blevesearch/bleve/v2/search/query"
	indexapi "github.com/blevesearch/bleve_index_api"
	"lexical-search/archive"
	"lexical-search/server"
)

const embeddingDimensions = 768

// Deliberately fixed to the local test runtime, not an arbitrary remote URL.
var embeddingURL = "http://127.0.0.1:11435" // Variable only to isolate HTTP tests.

var errEmbeddingInput = errors.New("Ollama rejected embedding input")

const embeddingModel = "embeddinggemma:300m"

func ollamaJSON(ctx context.Context, path string, input, output interface{}) error {
	var body io.Reader
	method := http.MethodGet
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body, method = bytes.NewReader(data), http.MethodPost
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, embeddingURL+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusBadRequest {
		return fmt.Errorf("%w: %s", errEmbeddingInput, path)
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Ollama %s: HTTP %d", path, response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(output)
}

func embeddingIdentity(ctx context.Context) (string, error) {
	var response struct {
		Models []struct {
			Name   string `json:"name"`
			Digest string `json:"digest"`
		} `json:"models"`
	}
	if err := ollamaJSON(ctx, "/api/tags", nil, &response); err != nil {
		return "", err
	}
	for _, model := range response.Models {
		if model.Name == embeddingModel && model.Digest != "" {
			return model.Digest + ":retrieval-1", nil
		}
	}
	return "", fmt.Errorf("pull %s into the local Ollama test server first", embeddingModel)
}

func embedTexts(ctx context.Context, texts []string) ([][]float32, error) {
	var response struct {
		Embeddings [][]float32 `json:"embeddings"`
	}
	if err := ollamaJSON(ctx, "/api/embed", map[string]interface{}{"model": embeddingModel, "input": texts, "truncate": false, "dimensions": embeddingDimensions}, &response); err != nil {
		return nil, err
	}
	if len(response.Embeddings) != len(texts) {
		return nil, fmt.Errorf("Ollama returned wrong vector count")
	}
	for _, vector := range response.Embeddings {
		if len(vector) != embeddingDimensions {
			return nil, fmt.Errorf("Ollama returned wrong vector dimensions")
		}
		var norm float64
		for _, v := range vector {
			if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
				return nil, fmt.Errorf("Ollama returned nonfinite vector")
			}
			norm += float64(v) * float64(v)
		}
		if norm == 0 {
			return nil, fmt.Errorf("Ollama returned zero vector")
		}
	}
	return response.Embeddings, nil
}

func prepareEmbeddingQuery(ctx context.Context, text string) ([]float32, string, error) {
	if os.Getenv("ARCHIVE_EMBEDDINGS") != "1" {
		return nil, "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	model, err := embeddingIdentity(ctx)
	if err != nil {
		return nil, "", err
	}
	vectors, err := embedTexts(ctx, []string{"task: search result | query: " + text})
	if err != nil {
		return nil, "", err
	}
	// A mutable model tag must not mix vectors from different weights.
	current, err := embeddingIdentity(ctx)
	if err != nil || current != model {
		return nil, "", fmt.Errorf("embedding model changed during inference")
	}
	return vectors[0], model, nil
}

func modelQuery(model string) *blevequery.TermQuery {
	term := bleve.NewTermQuery(model)
	term.SetField("embedding_model")
	return term
}

// Additive mapping migration: existing text postings remain valid. Bleve exposes
// internal metadata but no mapping-update method; _mapping is its persisted key.
// Call only with the workspace mutex held and before indexing any vectors.
func ensureEmbeddingMapping(index bleve.Index) error {
	mapping, ok := index.Mapping().(*blevemapping.IndexMappingImpl)
	if !ok {
		return fmt.Errorf("unexpected Bleve mapping")
	}
	doc := mapping.TypeMapping["slidingChunk"]
	if doc == nil {
		return fmt.Errorf("missing slidingChunk mapping")
	}
	if doc.Properties["embedding"] != nil && mapping.DefaultMapping.Properties["embedding"] != nil {
		return nil
	}
	vector := bleve.NewVectorFieldMapping()
	vector.Dims, vector.Similarity = embeddingDimensions, indexapi.CosineSimilarity
	doc.AddFieldMappingsAt("embedding", vector)
	mapping.DefaultMapping.AddFieldMappingsAt("embedding", vector)
	keyword := bleve.NewKeywordFieldMapping()
	keyword.IncludeInAll = false
	doc.AddFieldMappingsAt("embedding_model", keyword)
	mapping.DefaultMapping.AddFieldMappingsAt("embedding_model", keyword)
	if err := mapping.Validate(); err != nil {
		return err
	}
	data, err := json.Marshal(mapping)
	if err != nil {
		return err
	}
	return index.SetInternal([]byte("_mapping"), data)
}

// One bounded batch per workspace per pass; failed batches retry on the next pass.
// Source edits replace chunk IDs. Verify IDs and stored text again after inference
// so an in-flight embedding cannot resurrect deleted or edited passages.
func backfillEmbeddings(ctx context.Context, workspace archive.WorkspaceRecord, model string, after *string) error {
	mutex := archive.GetWorkspaceMutex(workspace.WorkTree)
	readBatch := func() (*bleve.SearchResult, error) {
		mutex.Lock()
		defer mutex.Unlock()
		index, err := bleve.Open(workspace.BleveDir)
		if err != nil {
			return nil, err
		}
		defer index.Close()
		if err := ensureEmbeddingMapping(index); err != nil {
			return nil, err
		}
		query := bleve.NewBooleanQuery()
		query.AddMust(bleve.NewMatchAllQuery())
		query.AddMustNot(modelQuery(model))
		request := bleve.NewSearchRequestOptions(query, 16, 0, false)
		request.Fields = []string{"path", "text", "lineStart", "lineEnd"}
		request.SortBy([]string{"_id"})
		if *after != "" {
			request.SearchAfter = []string{*after}
		}
		return index.SearchInContext(ctx, request)
	}
	hits, err := readBatch()
	if err != nil {
		return err
	}
	if len(hits.Hits) == 0 {
		*after = ""
		return err
	}
	// Advance even on inference failure so one oversized passage cannot starve
	// later passages. Revisit failures after completing this pass.
	*after = hits.Hits[len(hits.Hits)-1].ID
	texts := make([]string, len(hits.Hits))
	for i, hit := range hits.Hits {
		texts[i] = "title: " + fmt.Sprint(hit.Fields["path"]) + " | text: " + fmt.Sprint(hit.Fields["text"])
	}
	vectors, err := embedTexts(ctx, texts)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !errors.Is(err, errEmbeddingInput) {
			return err
		}
		vectors = make([][]float32, len(texts))
		for i, text := range texts {
			one, err := embedTexts(ctx, []string{text})
			if err != nil {
				log.Printf("semantic_embedding chunk=%s error=%v", hits.Hits[i].ID, err)
				continue
			}
			vectors[i] = one[0]
		}
	}
	current, err := embeddingIdentity(ctx)
	if err != nil || current != model {
		return fmt.Errorf("embedding model changed during backfill")
	}
	mutex.Lock()
	defer mutex.Unlock()
	index, err := bleve.Open(workspace.BleveDir)
	if err != nil {
		return err
	}
	defer index.Close()
	batch := index.NewBatch()
	for i, hit := range hits.Hits {
		if len(vectors[i]) == 0 {
			continue
		}
		request := bleve.NewSearchRequest(bleve.NewDocIDQuery([]string{hit.ID}))
		request.Fields = []string{"path", "text", "lineStart", "lineEnd"}
		current, err := index.SearchInContext(ctx, request)
		if err != nil {
			return err
		}
		if len(current.Hits) != 1 || !reflect.DeepEqual(current.Hits[0].Fields, hit.Fields) {
			continue
		}
		hit.Fields["embedding"], hit.Fields["embedding_model"] = vectors[i], model
		if err := batch.Index(hit.ID, hit.Fields); err != nil {
			return err
		}
	}
	if err := index.Batch(batch); err != nil {
		return err
	}
	log.Printf("semantic_backfill workspace=%s indexed=%d pending_at_scan=%d", workspace.Id, batch.Size(), hits.Total)
	return nil
}

func WatchEmbeddings(ctx context.Context) {
	if os.Getenv("ARCHIVE_EMBEDDINGS") != "1" {
		<-ctx.Done()
		return
	}
	ticker := time.NewTicker(time.Second)
	cursors := map[string]string{}
	defer ticker.Stop()
	for {
		model, err := embeddingIdentity(ctx)
		if err == nil {
			var workspaces []archive.WorkspaceRecord
			workspaces, err = archive.GetWorkspaces(server.ListWorkspacesParams{})
			if err == nil {
				for _, workspace := range workspaces {
					if workspace.BleveDir != "" {
						after := cursors[workspace.Id.String()]
						if err := backfillEmbeddings(ctx, workspace, model, &after); err != nil {
							log.Printf("semantic_backfill workspace=%s error=%v", workspace.Id, err)
						}
						cursors[workspace.Id.String()] = after
					}
					if ctx.Err() != nil {
						return
					}
				}
			}
		}
		if err != nil && ctx.Err() == nil {
			log.Printf("semantic_backfill error=%v", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(30 * time.Second):
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func searchWithEmbeddings(ctx context.Context, index bleve.Index, request *bleve.SearchRequest, ids []string, vector []float32, model string) (*bleve.SearchResult, uint64, error) {
	limit := request.Size
	if len(vector) > 0 {
		request.Size = max(limit*3, 60)
	}
	lexical, err := index.SearchInContext(ctx, request)
	if err != nil || len(vector) == 0 {
		return lexical, 0, err
	}
	request.Size = limit
	semantic, coverage, err := searchEmbeddingCandidates(ctx, index, request, ids, vector, model)
	if err != nil {
		return nil, 0, err
	}
	return mergeSearchResults(lexical, semantic, limit), coverage, nil
}

func searchEmbeddingCandidates(ctx context.Context, index bleve.Index, request *bleve.SearchRequest, ids []string, vector []float32, model string) (result *bleve.SearchResult, indexed uint64, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = nil
			indexed = 0
			err = fmt.Errorf("vector query panic: %v", recovered)
		}
	}()
	filter := bleve.NewConjunctionQuery(bleve.NewDocIDQuery(ids), modelQuery(model))
	coverage := bleve.NewSearchRequestOptions(filter, 0, 0, false)
	count, err := index.SearchInContext(ctx, coverage)
	if err != nil {
		return nil, 0, err
	}
	if count.Status != nil && count.Status.Failed > 0 {
		return nil, 0, fmt.Errorf("Bleve embedding coverage failed: %v", count.Status.Errors)
	}
	if count.Total == 0 {
		return nil, 0, nil
	}
	knn := bleve.NewSearchRequestOptions(bleve.NewMatchNoneQuery(), max(request.Size*3, 60), 0, false)
	knn.AddKNNWithFilter("embedding", vector, int64(max(request.Size*3, 60)), 1, filter)
	knn.Fields, knn.Sort = request.Fields, request.Sort
	semantic, err := index.SearchInContext(ctx, knn)
	if err != nil {
		return nil, 0, err
	}
	if semantic.Status != nil && semantic.Status.Failed > 0 {
		return nil, 0, fmt.Errorf("Bleve vector search failed: %v", semantic.Status.Errors)
	}
	return semantic, count.Total, nil
}
