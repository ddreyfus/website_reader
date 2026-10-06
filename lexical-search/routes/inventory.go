package routes

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"lexical-search/archive"
	"lexical-search/config"
)

// Inventory pagination is independent of lexical relevance and search limits.
func inventoryPage(c *gin.Context) (int, int, error) {
	offset, err := strconv.Atoi(c.DefaultQuery("offset", "0"))
	if err != nil || offset < 0 {
		return 0, 0, fmt.Errorf("offset must be a nonnegative integer")
	}
	limit, err := strconv.Atoi(c.DefaultQuery("limit", "30"))
	if err != nil || limit < 1 || limit > 100 {
		return 0, 0, fmt.Errorf("limit must be 1–100")
	}
	return offset, limit, nil
}

func listDocuments(c *gin.Context) {
	offset, limit, err := inventoryPage(c)
	if err != nil {
		ErrorHandler(c, err, 400)
		return
	}
	workspaces, unlock, err := lockArchiveWorkspaces()
	if err != nil {
		ErrorHandler(c, err, 500)
		return
	}
	defer unlock()
	scopeID := c.Query("corpus_id")
	scopePath, scopeWorkspace := "", ""
	if scopeID != "" {
		workspace, path, err := parseArchiveID(scopeID, workspaces)
		if err != nil {
			ErrorHandler(c, err, 404)
			return
		}
		scopePath, scopeWorkspace = path, workspace.Id.String()
	}
	documents := []gin.H{}
	for _, workspace := range workspaces {
		if scopeID != "" && workspace.Id.String() != scopeWorkspace {
			continue
		}
		records, err := fileChunks(workspace)
		if err != nil {
			ErrorHandler(c, err, 500)
			return
		}
		previous := ""
		for _, record := range records {
			if record.Path == previous {
				continue
			}
			previous = record.Path
			if scopeID != "" && !config.ContainsPath(scopePath, record.Path) {
				continue
			}
			if !strings.Contains(strings.ToLower(record.Path), strings.ToLower(c.Query("path_contains"))) {
				continue
			}
			id := archiveID(workspace, record.Path)
			documents = append(documents, gin.H{"document_id": id, "corpus_id": archiveID(workspace, filepath.Dir(record.Path)), "title": filepath.Base(record.Path), "path": record.Path, "url": "/file/" + id})
		}
	}
	sort.Slice(documents, func(i, j int) bool {
		if documents[i]["path"] == documents[j]["path"] {
			return documents[i]["document_id"].(string) < documents[j]["document_id"].(string)
		}
		return documents[i]["path"].(string) < documents[j]["path"].(string)
	})
	total := len(documents)
	start := min(offset, total)
	end := min(start+limit, total)
	var next interface{}
	if end < total {
		next = end
	}
	c.JSON(200, gin.H{"documents": documents[start:end], "total": total, "offset": offset, "next_offset": next})
}

func listArticles(c *gin.Context) {
	offset, limit, err := inventoryPage(c)
	if err != nil {
		ErrorHandler(c, err, 400)
		return
	}
	workspaces, unlock, err := lockArchiveWorkspaces()
	if err != nil {
		ErrorHandler(c, err, 500)
		return
	}
	defer unlock()
	workspace, path, err := parseArchiveID(c.Param("id"), workspaces)
	if err != nil || path == "." {
		ErrorHandler(c, fmt.Errorf("unknown document"), 404)
		return
	}
	records, err := fileChunks(workspace)
	if err != nil {
		ErrorHandler(c, err, 500)
		return
	}
	known := false
	for _, record := range records {
		if record.Path == path {
			known = true
			break
		}
	}
	if !known {
		ErrorHandler(c, fmt.Errorf("document is not indexed"), 404)
		return
	}
	full := filepath.Join(workspace.WorkTree, path)
	resolved, err := filepath.EvalSymlinks(full)
	if err != nil {
		ErrorHandler(c, fmt.Errorf("document unavailable"), 404)
		return
	}
	info, err := os.Lstat(full)
	if err != nil || !info.Mode().IsRegular() || !config.ContainsPath(workspace.WorkTree, resolved) {
		ErrorHandler(c, fmt.Errorf("document is not a regular file within its source directory"), 403)
		return
	}
	if archive.NeedsExtraction(path) {
		resolved = archive.TextPath(&workspace, path)
		info, err = os.Stat(resolved)
		if err != nil {
			ErrorHandler(c, fmt.Errorf("extracted text unavailable; wait for reconciliation"), 409)
			return
		}
	}
	file, err := os.Open(resolved)
	if err != nil {
		ErrorHandler(c, err, 404)
		return
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 8192)
	entries := []gin.H{}
	total, line := 0, 0
	var position int64
	anchored := false
	anchor, fence := "", ""
	var pending gin.H
	flush := func(endLine int, endOffset int64) {
		if pending == nil {
			return
		}
		pending["line_end"], pending["end_offset"] = endLine, endOffset
		if total >= offset && len(entries) < limit {
			entries = append(entries, pending)
		}
		total++
		pending = nil
	}
	for {
		if err := c.Request.Context().Err(); err != nil {
			return
		}
		start := position
		text := []byte{}
		oversized := false
		var readErr error
		for {
			if c.Request.Context().Err() != nil {
				return
			}
			part, err := reader.ReadSlice('\n')
			position += int64(len(part))
			if len(text)+len(part) <= 8192 && !oversized {
				text = append(text, part...)
			} else {
				if !oversized && bytes.HasPrefix(bytes.TrimSpace(text), []byte("#")) {
					ErrorHandler(c, fmt.Errorf("heading exceeds the 8192-byte inventory limit; read the document directly"), 422)
					return
				}
				oversized = true
				text = nil
			}
			if err != bufio.ErrBufferFull {
				readErr = err
				break
			}
		}
		if position == start && readErr == io.EOF {
			break
		}
		if readErr != nil && readErr != io.EOF {
			ErrorHandler(c, readErr, 500)
			return
		}
		line++
		if !oversized {
			value := strings.TrimSpace(string(bytes.TrimRight(text, "\r\n")))
			if strings.HasPrefix(value, "```") || strings.HasPrefix(value, "~~~") {
				marker := value[:3]
				if fence == "" {
					fence = marker
				} else if marker == fence {
					fence = ""
				}
			} else if fence == "" {
				if strings.HasPrefix(value, `<a id="article-`) && strings.HasSuffix(value, `"></a>`) || value == `<a id="original-email"></a>` {
					if !anchored {
						entries = []gin.H{}
						total = 0
						pending = nil
						anchored = true
					}
					flush(line-1, start)
					anchor = strings.TrimSuffix(strings.TrimPrefix(value, `<a id="`), `"></a>`)
				} else {
					hashes := len(value) - len(strings.TrimLeft(value, "#"))
					if hashes >= 1 && hashes <= 6 && len(value) > hashes && value[hashes] == ' ' {
						title := strings.TrimSpace(value[hashes:])
						if !anchored || anchor != "" && hashes == 2 {
							flush(line-1, start)
							kind := "heading"
							if anchored {
								kind = "article"
								if anchor == "original-email" {
									kind = "email"
								}
							}
							pending = gin.H{"title": title, "kind": kind, "anchor": anchor, "level": hashes, "line_start": line, "offset": start, "document_id": c.Param("id"), "url": fmt.Sprintf("/file/%s?line=%d", c.Param("id"), line)}
							anchor = ""
						}
					}
				}
			}
		}
		if readErr == io.EOF {
			break
		}
	}
	flush(line, position)
	current, err := file.Stat()
	if err != nil || current.Size() != info.Size() || !current.ModTime().Equal(info.ModTime()) {
		ErrorHandler(c, fmt.Errorf("document changed during inventory; retry"), 409)
		return
	}
	var next interface{}
	if offset < total && len(entries) < total-offset {
		next = offset + len(entries)
	}
	mode := "headings"
	if anchored {
		mode = "article_anchors"
	}
	c.JSON(http.StatusOK, gin.H{"articles": entries, "document_id": c.Param("id"), "inventory_mode": mode, "total": total, "offset": offset, "next_offset": next, "source_size": position, "source_modified_at": info.ModTime()})
}
