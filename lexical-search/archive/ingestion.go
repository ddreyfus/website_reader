package archive

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/blevesearch/bleve/v2"
	"github.com/jmoiron/sqlx"
)

const ingestionSchema = `CREATE TABLE IF NOT EXISTS ingestion (
 path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, version TEXT NOT NULL,
 chunks INTEGER NOT NULL, text_hash TEXT NOT NULL, error TEXT NOT NULL,
 job_pid INTEGER NOT NULL DEFAULT 0
);`

// Additive migration for archives created before per-file jobs were tracked.
func ensureIngestionDB(db *sqlx.DB) error {
	if _, err := db.Exec(ingestionSchema); err != nil {
		return err
	}
	rows, err := db.Query("PRAGMA table_info(ingestion)")
	if err != nil {
		return err
	}
	found := false
	for rows.Next() {
		var ordinal, notNull, primary int
		var name, kind string
		var fallback sql.NullString
		if err := rows.Scan(&ordinal, &name, &kind, &notNull, &fallback, &primary); err != nil {
			rows.Close()
			return err
		}
		if name == "job_pid" {
			found = true
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !found {
		_, err = db.Exec("ALTER TABLE ingestion ADD COLUMN job_pid INTEGER NOT NULL DEFAULT 0")
	}
	return err
}

func jobDirectory(workspace *WorkspaceRecord, path string) string {
	return TextPath(workspace, path) + ".job"
}

// The PID owns the service job, not its short-lived Java child.
func claimExtraction(db *sqlx.DB, workspace *WorkspaceRecord, path string) (bool, error) {
	if _, err := db.Exec("INSERT OR IGNORE INTO ingestion(path,fingerprint,version,chunks,text_hash,error) VALUES (?, '', '', 0, '', '')", path); err != nil {
		return false, err
	}
	result, err := db.Exec("UPDATE ingestion SET job_pid=? WHERE path=? AND job_pid=0", os.Getpid(), path)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count == 1, err
}

// A different live process may still be extracting. Only dead owners are cleaned.
func cleanAbandonedJobs(db *sqlx.DB, workspace *WorkspaceRecord) error {
	rows, err := db.Query("SELECT path,job_pid FROM ingestion WHERE job_pid != 0")
	if err != nil {
		return err
	}
	abandoned := map[string]int{}
	for rows.Next() {
		var path string
		var pid int
		if err := rows.Scan(&path, &pid); err != nil {
			rows.Close()
			return err
		}
		dead := syscall.Kill(pid, 0) == syscall.ESRCH
		if pid != os.Getpid() && dead {
			abandoned[path] = pid
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for path, pid := range abandoned {
		if !NeedsExtraction(path) || filepath.IsAbs(path) || filepath.Clean(path) != path || strings.HasPrefix(path, ".."+string(filepath.Separator)) {
			return fmt.Errorf("invalid extraction job path: %s", path)
		}
		if err := os.RemoveAll(jobDirectory(workspace, path)); err != nil {
			return err
		}
		if _, err := db.Exec("UPDATE ingestion SET job_pid=0,error='abandoned extraction; retry' WHERE path=? AND job_pid=?", path, pid); err != nil {
			return err
		}
	}
	return nil
}

func SupportedFile(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".txt", ".md", ".pdf", ".doc", ".docx", ".docm", ".html", ".htm":
		return true
	}
	return false
}

func NeedsExtraction(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return SupportedFile(path) && ext != ".txt" && ext != ".md"
}

func tikaJar() string {
	if path := os.Getenv("TIKA_APP_JAR"); path != "" {
		return path
	}
	executable, _ := os.Executable()
	return filepath.Join(filepath.Dir(filepath.Dir(executable)), "tika", "tika-app-4.1.0.jar")
}

func extractionVersion(path string) string {
	if !NeedsExtraction(path) {
		return "utf8-1"
	}
	version := "tika-4.1.0-text-2:" + tikaJar()
	if info, err := os.Stat(tikaJar()); err == nil {
		version += fmt.Sprintf(":%d:%d", info.Size(), info.ModTime().UnixNano())
	}
	return version
}

// Source paths remain document identities; generated text is outside source trees.
func TextPath(workspace *WorkspaceRecord, path string) string {
	if !NeedsExtraction(path) {
		return filepath.Join(workspace.WorkTree, path)
	}
	return filepath.Join(filepath.Dir(workspace.BleveDir), "extracted", path+".txt")
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

// Compare the current checkpoint with ingestion state, SQLite chunks and Bleve.
// This also backfills unchanged files when support or the extractor is added.
func reconcileFiles(ctx context.Context, workspace *WorkspaceRecord, db *sqlx.DB, index bleve.Index, changed []string) ([]string, map[string]string, error) {
	if err := cleanAbandonedJobs(db, workspace); err != nil {
		return nil, nil, err
	}
	output, err := exec.CommandContext(ctx, "git", "--git-dir="+filepath.Join(workspace.GitDir, ".git"), "ls-files", "--stage", "-z").Output()
	if err != nil {
		return nil, nil, err
	}
	fingerprints := map[string]string{}
	for _, record := range strings.Split(string(output), "\x00") {
		parts := strings.SplitN(record, "\t", 2)
		if len(parts) != 2 || !SupportedFile(parts[1]) {
			continue
		}
		fields := strings.Fields(parts[0])
		if len(fields) == 3 {
			fingerprints[parts[1]] = fields[1]
		}
	}
	var paths []string
	if err := db.Select(&paths, "SELECT path FROM ingestion UNION SELECT path FROM fileChunks"); err != nil {
		return nil, nil, err
	}
	for _, path := range paths {
		if fingerprints[path] == "" {
			changed = union(changed, []string{path})
		}
	}
	for path, fingerprint := range fingerprints {
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		var recorded, version, textHash, failure string
		var count, actual, owner int
		err := db.QueryRow("SELECT fingerprint, version, chunks, text_hash, error, job_pid FROM ingestion WHERE path = ?", path).Scan(&recorded, &version, &count, &textHash, &failure, &owner)
		if owner != 0 {
			continue
		}
		if err := db.Get(&actual, "SELECT COUNT(*) FROM fileChunks WHERE path = ?", path); err != nil {
			return nil, nil, err
		}
		stale := err != nil || recorded != fingerprint || version != extractionVersion(path) || failure != "" || count != actual
		if !stale && NeedsExtraction(path) {
			hash, err := hashFile(TextPath(workspace, path))
			stale = err != nil || hash != textHash
		}
		if !stale {
			var ids []string
			if err := db.Select(&ids, "SELECT id FROM fileChunks WHERE path = ?", path); err != nil {
				return nil, nil, err
			}
			for _, id := range ids {
				document, err := index.Document(id)
				if err != nil {
					return nil, nil, err
				}
				if document == nil {
					stale = true
					break
				}
			}
		}
		if stale {
			changed = union(changed, []string{path})
		}
	}
	// SQLite may have lost rows after Bleve was written (or vice versa).
	// Remove orphan passages so repairing a file cannot leave duplicate hits.
	var records []FileChunkRecord
	if err := db.Select(&records, "SELECT * FROM fileChunks"); err != nil {
		return nil, nil, err
	}
	known := map[string]string{}
	for _, record := range records {
		known[record.Id.String()] = record.Path
	}
	orphans := index.NewBatch()
	for offset := 0; ; offset += 1000 {
		request := bleve.NewSearchRequestOptions(bleve.NewMatchAllQuery(), 1000, offset, false)
		request.Fields = []string{"path"}
		request.SortBy([]string{"_id"})
		hits, err := index.SearchInContext(ctx, request)
		if err != nil {
			return nil, nil, err
		}
		for _, hit := range hits.Hits {
			if path, ok := hit.Fields["path"].(string); !ok || known[hit.ID] != path {
				orphans.Delete(hit.ID)
				if ok && fingerprints[path] != "" {
					changed = union(changed, []string{path})
				}
			}
		}
		if len(hits.Hits) < 1000 {
			break
		}
	}
	if err := index.Batch(orphans); err != nil {
		return nil, nil, err
	}
	return changed, fingerprints, nil
}

func prepareText(ctx context.Context, workspace *WorkspaceRecord, path, fingerprint string) (string, string, error) {
	source := filepath.Join(workspace.WorkTree, path)
	info, err := os.Lstat(source)
	if err != nil || !info.Mode().IsRegular() {
		return "", "", fmt.Errorf("source is unavailable or not a regular file")
	}
	resolved, err := filepath.EvalSymlinks(source)
	if err != nil {
		return "", "", err
	}
	root, err := filepath.EvalSymlinks(workspace.WorkTree)
	if err != nil {
		return "", "", err
	}
	relative, err := filepath.Rel(root, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("source escaped its directory")
	}
	textPath := TextPath(workspace, path)
	if !NeedsExtraction(path) {
		return textPath, "", nil
	}
	if _, err := os.Stat(tikaJar()); err != nil {
		return "", "", fmt.Errorf("Tika is unavailable; run npm run tika:install or set TIKA_APP_JAR: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 32*time.Minute)
	defer cancel()
	if err := os.MkdirAll(jobDirectory(workspace, path), 0700); err != nil {
		return "", "", err
	}
	xhtml, err := os.CreateTemp(jobDirectory(workspace, path), ".tika-*")
	if err != nil {
		return "", "", err
	}
	defer os.Remove(xhtml.Name())
	defer xhtml.Close()
	// Override the CLI's embedded-image OCR default; AUTO uses native page text
	// first and OCR only for pages with insufficient readable text.
	configuration := filepath.Join(jobDirectory(workspace, path), "tika.json")
	if err := os.WriteFile(configuration, []byte(`{
  "parsers": [
    {"default-parser": {}},
    {"pdf-parser": {
      "extractActions": true,
      "extractInlineImages": false,
      "accessCheckMode": "ALLOW_EXTRACTION_FOR_ACCESSIBILITY",
      "extractIncrementalUpdateInfo": true,
      "parseIncrementalUpdates": true,
      "pages": {"text": "AUTO"}
    }},
    {"ooxml-parser": {"includeDeletedContent": true, "includeMoveFromContent": true, "extractMacros": true}},
    {"office-parser": {"extractMacros": true}}
  ],
  "parse-context": {"timeout-limits": {"throwOnDeadline": true}}
}`), 0600); err != nil {
		return "", "", err
	}
	command := exec.CommandContext(ctx, "java", "-Djava.awt.headless=true", "-Xmx512m", "-jar", tikaJar(), "--config="+configuration, "--fork", "--fork-jvm-args=-Xmx512m,-Djava.awt.headless=true", "--task-timeout=1800000", "--progress-timeout=120000", "--xml", "--encoding=UTF-8", source)
	command.Stdout = xhtml
	// Keep logs on disk while parsing; only the bounded tail enters ingestion errors.
	logs, err := os.CreateTemp(jobDirectory(workspace, path), ".tika-log-*")
	if err != nil {
		return "", "", err
	}
	defer logs.Close()
	defer os.Remove(logs.Name())
	command.Stderr = logs
	if err := command.Run(); err != nil {
		size, _ := logs.Seek(0, io.SeekEnd)
		logs.Seek(max(int64(0), size-4096), io.SeekStart)
		detail, _ := io.ReadAll(io.LimitReader(logs, 4096))
		return "", "", fmt.Errorf("Tika extraction failed: %w: %s", err, detail)
	}
	// Check content, not timestamps alone, before publishing the extracted version.
	blob, err := exec.CommandContext(ctx, "git", "--git-dir="+filepath.Join(workspace.GitDir, ".git"), "hash-object", "--", source).Output()
	if err != nil || strings.TrimSpace(string(blob)) != fingerprint {
		return "", "", fmt.Errorf("source changed during extraction; retry")
	}
	xhtml.Seek(0, io.SeekStart)
	text, err := os.CreateTemp(jobDirectory(workspace, path), ".text-*")
	if err != nil {
		return "", "", err
	}
	if err := extractedText(xhtml, text); err != nil {
		text.Close()
		return "", "", err
	}
	if err := text.Close(); err != nil {
		return "", "", err
	}
	hash, err := hashFile(text.Name())
	if err != nil {
		return "", "", err
	}
	return text.Name(), hash, nil
}

// Convert Tika XHTML to readable UTF-8 while retaining PDF page markers,
// heading levels, table cell separation and link destinations.
func extractedText(input io.Reader, output io.Writer) error {
	decoder := xml.NewDecoder(input)
	body, skip, page := false, 0, 0
	seenBody := false
	var links []string
	write := func(value string) error { _, err := io.WriteString(output, value); return err }
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			if !seenBody {
				return fmt.Errorf("Tika output has no XHTML body")
			}
			return nil
		}
		if err != nil {
			return fmt.Errorf("invalid Tika XHTML: %w", err)
		}
		switch node := token.(type) {
		case xml.StartElement:
			if node.Name.Local == "meta" {
				for _, attribute := range node.Attr {
					if attribute.Name.Local == "name" && attribute.Value == "tk:exception:task-deadline-reached" {
						return fmt.Errorf("Tika extraction exceeded its runtime or progress limit")
					}
				}
			}
			name := node.Name.Local
			if name == "body" {
				body, seenBody = true, true
			}
			if !body {
				continue
			}
			if name == "script" || name == "style" || name == "nav" {
				skip++
			}
			if skip > 0 {
				continue
			}
			if name == "div" {
				for _, attr := range node.Attr {
					if attr.Name.Local == "class" && attr.Value == "page" {
						page++
						if err := write("\n\n## Page " + strconv.Itoa(page) + "\n\n"); err != nil {
							return err
						}
					}
				}
			}
			switch name {
			case "p", "div", "table", "tr", "ul", "ol", "br":
				if err := write("\n"); err != nil {
					return err
				}
			case "li":
				if err := write("\n- "); err != nil {
					return err
				}
			case "h1", "h2", "h3", "h4", "h5", "h6":
				if err := write("\n" + strings.Repeat("#", int(name[1]-'0')) + " "); err != nil {
					return err
				}
			case "a":
				href := ""
				for _, attr := range node.Attr {
					if attr.Name.Local == "href" {
						href = attr.Value
					}
				}
				links = append(links, href)
			}
		case xml.EndElement:
			name := node.Name.Local
			if name == "script" || name == "style" || name == "nav" {
				if skip > 0 {
					skip--
				}
				continue
			}
			if !body || skip > 0 {
				continue
			}
			switch name {
			case "body":
				body = false
			case "a":
				if len(links) > 0 {
					href := links[len(links)-1]
					links = links[:len(links)-1]
					if href != "" {
						if err := write(" (" + href + ")"); err != nil {
							return err
						}
					}
				}
			case "td", "th":
				if err := write("\t"); err != nil {
					return err
				}
			case "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6":
				if err := write("\n"); err != nil {
					return err
				}
			}
		case xml.CharData:
			if body && skip == 0 {
				if err := write(string(node)); err != nil {
					return err
				}
			}
		}
	}
}
