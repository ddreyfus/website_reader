package trigram

import (
	"github.com/blevesearch/bleve/v2/analysis"
	"github.com/blevesearch/bleve/v2/analysis/token/ngram"
	"github.com/blevesearch/bleve/v2/registry"
)

const Name = "trigram"

func TrigramFilterConstructor(config map[string]interface{}, cache *registry.Cache) (analysis.TokenFilter, error) {
	min := 3
	max := 3
	return ngram.NewNgramFilter(min, max), nil
}

func init() {
	registry.RegisterTokenFilter(Name, TrigramFilterConstructor)
}
