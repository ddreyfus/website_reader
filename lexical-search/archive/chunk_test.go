package archive

import (
	"lexical-search/config"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestChunkFilePreservesLongText(t *testing.T) {
	for _, text := range []string{
		strings.Repeat("long paragraph é ", 10000) + "finalneedle",
		strings.Repeat("a substantial article paragraph "+strings.Repeat("x", 500)+"\n", 100) + "finalneedle",
	} {
		path := filepath.Join(t.TempDir(), "article.md")
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		chunks, err := ChunkFile(path, config.FILE_CHUNK_LINES)
		if err != nil {
			t.Fatal(err)
		}
		covered := 0
		for _, chunk := range chunks {
			if len(chunk.Text) > config.MAX_CHUNK_LENGTH || !utf8.ValidString(chunk.Text) || chunk.Lines[0] > chunk.Lines[1] {
				t.Fatalf("invalid chunk: %+v", chunk)
			}
			end := covered + len(chunk.Text)
			if covered == 0 {
				if !strings.HasPrefix(text, chunk.Text) {
					t.Fatal("first chunk mismatch")
				}
				covered = end
				continue
			}
			overlap := 0
			for n := 256; n >= 0; n-- {
				if n <= covered && n <= len(chunk.Text) && strings.HasSuffix(text[:covered], chunk.Text[:n]) && strings.HasPrefix(text[covered:], chunk.Text[n:]) {
					overlap = n
					break
				}
			}
			if !strings.HasPrefix(text[covered:], chunk.Text[overlap:]) {
				t.Fatal("chunk lost original text")
			}
			covered += len(chunk.Text) - overlap
		}
		if covered != len(text) {
			t.Fatalf("covered %d of %d bytes", covered, len(text))
		}
	}
}
