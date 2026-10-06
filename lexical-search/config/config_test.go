package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	port, root, _, searchLimit, err := Read(path)
	if err != nil || port != 8766 || root != "~/reading-archive" || searchLimit != 30 {
		t.Fatalf("defaults: %d %s %v", port, root, err)
	}
	if err = Save(path, 9876, "~/custom-archive", []string{"~/articles"}, 30); err != nil {
		t.Fatal(err)
	}
	port, root, directories, _, err := Read(path)
	if err != nil || port != 9876 || root != "~/custom-archive" || len(directories) != 1 || directories[0] != "~/articles" {
		t.Fatalf("round trip: %d %s %v", port, root, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode: %v", info.Mode())
	}
	expanded, err := ExpandArchiveRoot(root)
	if err != nil || !filepath.IsAbs(expanded) {
		t.Fatalf("expansion: %s %v", expanded, err)
	}
	for _, body := range []string{`null`, `[]`, `{"port":0}`, `{"port":65536}`, `{"port":1.5}`, `{"port":null}`, `{"archive_root":null}`, `{"archive_root":"relative"}`, `{"api_key":"secret"}`, `{"search_limit":0}`, `{"search_limit":101}`, `{"search_limit":null}`, `{"search_limit":1.5}`, `{"index_directories":null}`, `{"index_directories":["relative"]}`, `{"index_directories":["~/articles","~/articles/sub"]}`, `{"index_directories":["~/reading-archive"]}`} {
		if _, _, _, _, err := Parse([]byte(body)); err == nil {
			t.Errorf("accepted invalid config: %s", body)
		}
	}
	if err = Save(path, 0, root, nil, 30); err == nil {
		t.Fatal("invalid save accepted")
	}
	port, _, _, _, err = Read(path)
	if err != nil || port != 9876 {
		t.Fatal("invalid write changed saved config")
	}
}
