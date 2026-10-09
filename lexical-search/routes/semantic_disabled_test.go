//go:build !vectors

package routes

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/blevesearch/bleve/v2"
	"lexical-search/mapping"
)

func TestSemanticDisabledBuild(t *testing.T) {
	t.Setenv("ARCHIVE_EMBEDDINGS", "")
	vector, model, err := prepareEmbeddingQuery(context.Background(), "query")
	if err != nil || vector != nil || model != "" {
		t.Fatalf("disabled inference: %v %q %v", vector, model, err)
	}
	t.Setenv("ARCHIVE_EMBEDDINGS", "1")
	if _, _, err := prepareEmbeddingQuery(context.Background(), "query"); err == nil {
		t.Fatal("ordinary build claims semantic support")
	}
	m, err := mapping.SlidingChunkMapping()
	if err != nil {
		t.Fatal(err)
	}
	index, err := bleve.New(filepath.Join(t.TempDir(), "index"), m)
	if err != nil {
		t.Fatal(err)
	}
	defer index.Close()
	if err := index.Index("passage", map[string]interface{}{"text": "lexical passage"}); err != nil {
		t.Fatal(err)
	}
	request := bleve.NewSearchRequest(bleve.NewMatchAllQuery())
	hits, coverage, err := searchWithEmbeddings(context.Background(), index, request, nil, nil, "")
	if err != nil || coverage != 0 || len(hits.Hits) != 1 {
		t.Fatalf("lexical result=%v coverage=%d error=%v", hits, coverage, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { WatchEmbeddings(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("ordinary-build worker did not stop")
	}
}
