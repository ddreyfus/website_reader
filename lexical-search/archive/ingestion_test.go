package archive

import (
	"bytes"
	"github.com/jmoiron/sqlx"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractedText(t *testing.T) {
	input := `<html><head><title/></head><body><nav>Menu noise</nav><div class="page"><h1>Report é</h1><p>First <a href="https://example.com/source">source</a>.</p><script>bad()</script><style>badcss</style><ul><li>Item</li></ul><table><tr><td>A</td><td>B</td></tr></table></div><div class="page"><h2>Second</h2><p>Evidence</p></div></body></html>`
	var result bytes.Buffer
	if err := extractedText(strings.NewReader(input), &result); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"## Page 1", "## Page 2", "# Report é", "## Second", "source (https://example.com/source)", "- Item", "A\tB\t", "Evidence"} {
		if !strings.Contains(result.String(), expected) {
			t.Fatalf("lost %q: %s", expected, result.String())
		}
	}
	for _, excluded := range []string{"Menu noise", "bad()", "badcss"} {
		if strings.Contains(result.String(), excluded) {
			t.Fatalf("included %q", excluded)
		}
	}
}

func TestExtractionJobRecovery(t *testing.T) {
	db, err := sqlx.Connect("sqlite", filepath.Join(t.TempDir(), "archive.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// Upgrade a database created by the initial extraction implementation.
	if _, err := db.Exec("CREATE TABLE ingestion(path TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,version TEXT NOT NULL,chunks INTEGER NOT NULL,text_hash TEXT NOT NULL,error TEXT NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	if err := ensureIngestionDB(db); err != nil {
		t.Fatal(err)
	}
	workspace := &WorkspaceRecord{WorkTree: t.TempDir(), BleveDir: filepath.Join(t.TempDir(), "index.bleve")}
	dead := exec.Command("true")
	if err := dead.Run(); err != nil {
		t.Fatal(err)
	}
	alive := exec.Command("sleep", "30")
	if err := alive.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { alive.Process.Kill(); alive.Wait() }()
	for path, pid := range map[string]int{"dead.pdf": dead.Process.Pid, "live.pdf": alive.Process.Pid, "own.pdf": os.Getpid()} {
		if _, err := db.Exec("INSERT INTO ingestion(path,fingerprint,version,chunks,text_hash,error,job_pid) VALUES (?,'','',0,'','',?)", path, pid); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(jobDirectory(workspace, path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(jobDirectory(workspace, path), "partial.txt"), []byte("partial"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := cleanAbandonedJobs(db, workspace); err != nil {
		t.Fatal(err)
	}
	var owner int
	db.Get(&owner, "SELECT job_pid FROM ingestion WHERE path='dead.pdf'")
	if owner != 0 {
		t.Fatal("dead claim retained")
	}
	if _, err := os.Stat(jobDirectory(workspace, "dead.pdf")); !os.IsNotExist(err) {
		t.Fatal("dead effort retained")
	}
	for _, path := range []string{"live.pdf", "own.pdf"} {
		db.Get(&owner, "SELECT job_pid FROM ingestion WHERE path=?", path)
		if owner == 0 {
			t.Fatal("live claim removed", path)
		}
		if _, err := os.Stat(filepath.Join(jobDirectory(workspace, path), "partial.txt")); err != nil {
			t.Fatal("live effort removed", path)
		}
	}
}

func TestExtractedTextRejectsDeadline(t *testing.T) {
	input := `<html><head><meta name="tk:exception:task-deadline-reached" content="true"/></head><body><p>Partial text</p></body></html>`
	var result bytes.Buffer
	if err := extractedText(strings.NewReader(input), &result); err == nil {
		t.Fatal("accepted incomplete extraction")
	}
}
