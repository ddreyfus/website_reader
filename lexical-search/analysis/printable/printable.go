package printable

import (
	"unicode"

	"github.com/blevesearch/bleve/v2/analysis"
	"github.com/blevesearch/bleve/v2/analysis/tokenizer/character"
	"github.com/blevesearch/bleve/v2/registry"
)

const Name = "printable"

func TokenizerConstructor(config map[string]interface{}, cache *registry.Cache) (analysis.Tokenizer, error) {
	return character.NewCharacterTokenizer(unicode.IsPrint), nil
}

func init() {
	registry.RegisterTokenizer(Name, TokenizerConstructor)
}
