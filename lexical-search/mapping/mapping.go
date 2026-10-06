package mapping

import (
	"lexical-search/analysis/chunk"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/analysis/lang/en"
	"github.com/blevesearch/bleve/v2/mapping"
)

func SlidingChunkMapping() (*mapping.IndexMappingImpl, error) {

	// Mapping for path field
	pathFieldMapping := bleve.NewTextFieldMapping()
	pathFieldMapping.Analyzer = chunk.Name

	// Mapping for lineStart field
	lineStartMapping := bleve.NewTextFieldMapping()
	lineStartMapping.Analyzer = en.AnalyzerName

	// Mapping for lineEnd field
	lineEndMapping := bleve.NewTextFieldMapping()
	lineEndMapping.Analyzer = en.AnalyzerName

	// Mapping for text field
	textMapping := bleve.NewTextFieldMapping()
	textMapping.Analyzer = chunk.Name

	// Define document
	slidingChunkMapping := bleve.NewDocumentMapping()
	slidingChunkMapping.AddFieldMappingsAt("path", pathFieldMapping)
	slidingChunkMapping.AddFieldMappingsAt("lineStart", lineStartMapping)
	slidingChunkMapping.AddFieldMappingsAt("lineEnd", lineEndMapping)
	slidingChunkMapping.AddFieldMappingsAt("text", textMapping)

	// Define index
	indexMapping := bleve.NewIndexMapping()
	indexMapping.TypeField = "slidingChunk"
	indexMapping.DefaultAnalyzer = chunk.Name
	indexMapping.AddDocumentMapping("slidingChunk", slidingChunkMapping)

	return indexMapping, nil

}
