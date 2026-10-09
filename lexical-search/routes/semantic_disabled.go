//go:build !vectors

package routes

import (
	"context"
	"fmt"
	"os"

	"github.com/blevesearch/bleve/v2"
)

func WatchEmbeddings(ctx context.Context) {
	<-ctx.Done()
}

func prepareEmbeddingQuery(ctx context.Context, text string) ([]float32, string, error) {
	if os.Getenv("ARCHIVE_EMBEDDINGS") == "1" {
		return nil, "", fmt.Errorf("semantic search requires the vectors build")
	}
	return nil, "", nil
}

func searchWithEmbeddings(ctx context.Context, index bleve.Index, request *bleve.SearchRequest, ids []string, vector []float32, model string) (*bleve.SearchResult, uint64, error) {
	result, err := index.SearchInContext(ctx, request)
	return result, 0, err
}

func searchEmbeddingCandidates(ctx context.Context, index bleve.Index, request *bleve.SearchRequest, ids []string, vector []float32, model string) (*bleve.SearchResult, uint64, error) {
	return nil, 0, fmt.Errorf("semantic search requires the vectors build")
}
