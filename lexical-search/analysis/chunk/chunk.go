package chunk

import (
	"lexical-search/analysis/printable"
	"lexical-search/analysis/trigram"

	"github.com/blevesearch/bleve/v2/analysis"
	"github.com/blevesearch/bleve/v2/analysis/token/lowercase"
	"github.com/blevesearch/bleve/v2/registry"
)

const Name = "chunk"

func AnalyzerConstructor(config map[string]interface{}, cache *registry.Cache) (analysis.Analyzer, error) {
	tokenizer, err := cache.TokenizerNamed(printable.Name)
	if err != nil {
		return nil, err
	}
	toLowerFilter, err := cache.TokenFilterNamed(lowercase.Name)
	if err != nil {
		return nil, err
	}
	toTrigram, err := cache.TokenFilterNamed(trigram.Name)
	if err != nil {
		return nil, err
	}
	rv := analysis.DefaultAnalyzer{
		Tokenizer: tokenizer,
		TokenFilters: []analysis.TokenFilter{
			toLowerFilter,
			toTrigram,
		},
	}
	return &rv, nil
}

func init() {
	registry.RegisterAnalyzer(Name, AnalyzerConstructor)
}
