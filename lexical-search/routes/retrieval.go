package routes

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/search"
	blevequery "github.com/blevesearch/bleve/v2/search/query"
	"github.com/gin-gonic/gin"
	"github.com/jmoiron/sqlx"
	"lexical-search/archive"
	"lexical-search/config"
	"lexical-search/server"
)

func RegisterRetrievalHandlers(router *gin.Engine) {
	router.GET("/api/v1/corpora", listCorpora)
	router.POST("/api/v1/archive/search", searchArchive)
	router.GET("/api/v1/documents", listDocuments)
	router.GET("/api/v1/documents/:id/articles", listArticles)
	router.GET("/api/v1/documents/:id", readDocument)
	router.GET("/file/:id", readDocument)
}

// Reuse workspace records and mutexes; no separate corpus index is created.
func lockArchiveWorkspaces() ([]archive.WorkspaceRecord, func(), error) {
	workspaces, err := archive.GetWorkspaces(server.ListWorkspacesParams{})
	if err != nil {
		return nil, func() {}, err
	}
	roots := map[string]bool{}
	for _, root := range config.IndexDirectories {
		root, err = config.ExpandArchiveRoot(root)
		if err != nil {
			return nil, func() {}, err
		}
		if resolved, err := filepath.EvalSymlinks(root); err == nil {
			root = resolved
		}
		roots[root] = true
	}
	sort.Slice(workspaces, func(i, j int) bool { return workspaces[i].WorkTree < workspaces[j].WorkTree })
	selected := []archive.WorkspaceRecord{}
	unlocks := []func(){}
	unlock := func() {
		for i := len(unlocks) - 1; i >= 0; i-- {
			unlocks[i]()
		}
	}
	for _, workspace := range workspaces {
		if !roots[workspace.WorkTree] {
			continue
		}
		mutex := archive.GetWorkspaceMutex(workspace.WorkTree)
		mutex.Lock()
		unlocks = append(unlocks, mutex.Unlock)
		current, err := archive.GetWorkspaceById(workspace.Id.String())
		if err != nil {
			unlock()
			return nil, func() {}, err
		}
		selected = append(selected, *current)
	}
	return selected, unlock, nil
}

func fileChunks(workspace archive.WorkspaceRecord) ([]archive.FileChunkRecord, error) {
	if workspace.BleveDir == "" {
		return nil, nil
	}
	db, err := sqlx.Connect("sqlite", archive.MakeArchiveDBPath(workspace.Id))
	if err != nil {
		return nil, err
	}
	defer db.Close()
	records := []archive.FileChunkRecord{}
	err = db.Select(&records, "SELECT * FROM fileChunks ORDER BY path, lineStart")
	return records, err
}

func archiveID(workspace archive.WorkspaceRecord, path string) string {
	return workspace.Id.String() + ":" + base64.RawURLEncoding.EncodeToString([]byte(filepath.ToSlash(path)))
}

func parseArchiveID(id string, workspaces []archive.WorkspaceRecord) (archive.WorkspaceRecord, string, error) {
	parts := strings.SplitN(id, ":", 2)
	if len(parts) != 2 {
		return archive.WorkspaceRecord{}, "", fmt.Errorf("invalid archive ID")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	path := string(raw)
	if err != nil || !utf8.Valid(raw) || strings.ContainsRune(path, 0) || filepath.IsAbs(path) || !config.ContainsPath(".", path) || filepath.ToSlash(filepath.Clean(path)) != path {
		return archive.WorkspaceRecord{}, "", fmt.Errorf("invalid archive path")
	}
	for _, workspace := range workspaces {
		if workspace.Id.String() == parts[0] {
			return workspace, path, nil
		}
	}
	return archive.WorkspaceRecord{}, "", fmt.Errorf("corpus is not in the configured archive")
}

func listCorpora(c *gin.Context) {
	workspaces, unlock, err := lockArchiveWorkspaces()
	if err != nil {
		ErrorHandler(c, err, 500)
		return
	}
	defer unlock()
	corpora := []gin.H{}
	for _, workspace := range workspaces {
		records, err := fileChunks(workspace)
		if err != nil {
			ErrorHandler(c, err, 500)
			return
		}
		documents := map[string]map[string]bool{".": {}}
		for _, record := range records {
			for directory := filepath.Dir(record.Path); ; directory = filepath.Dir(directory) {
				if documents[directory] == nil {
					documents[directory] = map[string]bool{}
				}
				documents[directory][record.Path] = true
				if directory == "." {
					break
				}
			}
		}
		directories := []string{}
		for directory := range documents {
			directories = append(directories, directory)
		}
		sort.Strings(directories)
		for _, directory := range directories {
			if len(documents[directory]) == 0 && c.Query("include_empty") != "true" {
				continue
			}
			var parent interface{}
			name := filepath.Base(directory)
			if directory == "." {
				name = workspace.Name
			} else {
				parent = archiveID(workspace, filepath.Dir(directory))
			}
			status := "ready"
			if _, err := os.Stat(workspace.WorkTree); err != nil {
				status = "unavailable"
			} else if workspace.BleveDir == "" {
				status = "pending"
			}
			corpora = append(corpora, gin.H{"id": archiveID(workspace, directory), "parent_id": parent, "name": name, "directory": filepath.ToSlash(directory), "description": "Directory corpus; searches include descendant directories.", "document_count": len(documents[directory]), "status": status, "updated_at": workspace.UpdatedAt})
		}
	}
	c.JSON(200, gin.H{"corpora": corpora})
}

func searchArchive(c *gin.Context) {
	started := time.Now()
	var query string
	limit := config.SearchLimit
	corpusIDs := []string{}
	results := []gin.H{}
	var totalMatches uint64
	var searchError string
	semanticStatus := "disabled"
	var semanticCoverage uint64
	fail := func(c *gin.Context, err error, status int) {
		searchError = err.Error()
		ErrorHandler(c, err, status)
	}
	defer func() {
		hits := make([]gin.H, 0, len(results))
		for _, result := range results {
			hits = append(hits, gin.H{"document_id": result["document_id"], "chunk_id": result["chunk_id"], "score": result["score"]})
		}
		entry := gin.H{"event": "archive_search", "timestamp": started.UTC().Format(time.RFC3339Nano), "query": query, "corpus_ids": corpusIDs, "limit": limit, "total_matches": totalMatches, "returned_count": len(results), "results": hits, "duration_ms": float64(time.Since(started).Microseconds()) / 1000, "status": c.Writer.Status(), "semantic_status": semanticStatus, "semantic_indexed_passages": semanticCoverage}
		if semanticCoverage > 0 {
			entry["lexical_total_matches"] = totalMatches
			entry["total_matches"] = nil // Top-K vector retrieval has no exhaustive match count.
		}
		if searchError != "" {
			entry["error"] = searchError
		}
		data, err := json.Marshal(entry)
		if err != nil {
			log.Printf("archive_search log encoding failed: %v", err)
			return
		}
		log.Print(string(data))
	}()
	var body map[string]json.RawMessage
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32768)
	if err := c.ShouldBindJSON(&body); err != nil {
		fail(c, err, 400)
		return
	}
	if err := json.Unmarshal(body["query"], &query); err != nil || strings.TrimSpace(query) == "" || len(query) > 4096 {
		fail(c, fmt.Errorf("query must contain 1–4096 bytes"), 400)
		return
	}
	if raw, ok := body["limit"]; ok {
		if err := json.Unmarshal(raw, &limit); err != nil {
			fail(c, err, 400)
			return
		}
	}
	if limit < 1 || limit > 100 {
		fail(c, fmt.Errorf("limit must be between 1 and 100"), 400)
		return
	}
	if raw, ok := body["corpus_ids"]; ok {
		if err := json.Unmarshal(raw, &corpusIDs); err != nil {
			fail(c, err, 400)
			return
		}
	}
	// Inference overlaps lexical retrieval; a slow runtime cannot add seconds.
	embeddingCtx, cancelEmbedding := context.WithTimeout(c.Request.Context(), 250*time.Millisecond)
	embeddingDone := make(chan struct{})
	var vector []float32
	var model string
	var embeddingErr error
	go func() {
		defer close(embeddingDone)
		defer func() {
			if recovered := recover(); recovered != nil {
				embeddingErr = fmt.Errorf("embedding query panic: %v", recovered)
			}
		}()
		vector, model, embeddingErr = prepareEmbeddingQuery(embeddingCtx, query)
	}()
	defer func() { cancelEmbedding(); <-embeddingDone }()
	workspaces, unlock, err := lockArchiveWorkspaces()
	if err != nil {
		fail(c, err, 500)
		return
	}
	defer unlock()
	scopes := map[string][]string{}
	for _, id := range corpusIDs {
		workspace, directory, err := parseArchiveID(id, workspaces)
		if err != nil {
			fail(c, err, 404)
			return
		}
		scopes[workspace.Id.String()] = append(scopes[workspace.Id.String()], directory)
	}
	alias := bleve.NewIndexAlias()
	owners := map[string]archive.WorkspaceRecord{}
	ids := []string{}
	for _, workspace := range workspaces {
		if workspace.BleveDir == "" {
			continue
		}
		if len(corpusIDs) > 0 && len(scopes[workspace.Id.String()]) == 0 {
			continue
		}
		records, err := fileChunks(workspace)
		if err != nil {
			fail(c, err, 500)
			return
		}
		for _, record := range records {
			include := len(corpusIDs) == 0
			for _, directory := range scopes[workspace.Id.String()] {
				if config.ContainsPath(directory, record.Path) {
					include = true
				}
			}
			if include {
				ids = append(ids, record.Id.String())
				owners[record.Id.String()] = workspace
			}
		}
		index, err := bleve.Open(workspace.BleveDir)
		if err != nil {
			fail(c, err, 500)
			return
		}
		defer index.Close()
		alias.Add(index)
	}
	if len(ids) > 0 {
		match := bleve.NewMatchQuery(query)
		match.SetField("text")
		match.SetOperator(blevequery.MatchQueryOperatorOr)
		query := bleve.NewConjunctionQuery(match, bleve.NewDocIDQuery(ids))
		request := bleve.NewSearchRequestOptions(query, limit, 0, false)
		request.Fields = []string{"path", "text", "lineStart", "lineEnd"}
		request.SortBy([]string{"-_score", "_id"})
		if os.Getenv("ARCHIVE_EMBEDDINGS") == "1" {
			request.Size = max(3*limit, 60)
		}
		lexicalDone := make(chan struct{})
		var lexical *bleve.SearchResult
		var lexicalErr error
		// request is immutable while lexical search runs; vector search gets a copy.
		go func() {
			defer close(lexicalDone)
			defer func() {
				if recovered := recover(); recovered != nil {
					lexicalErr = fmt.Errorf("lexical query panic: %v", recovered)
				}
			}()
			lexical, lexicalErr = alias.SearchInContext(c.Request.Context(), request)
		}()
		defer func() { <-lexicalDone }()

		if os.Getenv("ARCHIVE_EMBEDDINGS") == "1" {
			select {
			case <-embeddingDone:
				if embeddingErr != nil {
					semanticStatus = "unavailable"
					log.Printf("semantic_query error=%v", embeddingErr)
				} else if len(vector) > 0 {
					semanticStatus = "partial"
				}
			case <-embeddingCtx.Done():
				// Do not read inference output until its completion channel is closed.
				semanticStatus = "unavailable"
			}
		}
		var semantic *bleve.SearchResult
		if semanticStatus == "partial" && embeddingCtx.Err() != nil {
			semanticStatus = "unavailable"
		}
		if semanticStatus == "partial" {
			vectorRequest := *request
			vectorRequest.Size = limit
			semantic, semanticCoverage, err = searchEmbeddingCandidates(embeddingCtx, alias, &vectorRequest, ids, vector, model)
			if err != nil {
				semanticStatus = "unavailable"
				semanticCoverage = 0
				log.Printf("semantic_search error=%v", err)
			} else if semanticCoverage == uint64(len(ids)) {
				semanticStatus = "ready"
			}
		}
		<-lexicalDone
		if lexicalErr != nil {
			log.Printf("lexical_search error=%v", lexicalErr)
			if semantic == nil {
				fail(c, lexicalErr, 500)
				return
			}
			lexical = nil
		}
		hits := mergeSearchResults(lexical, semantic, limit)
		totalMatches = hits.Total
		for _, hit := range hits.Hits {
			workspace := owners[hit.ID]
			path, ok := hit.Fields["path"].(string)
			if !ok {
				continue
			}
			line, _ := strconv.Atoi(fmt.Sprint(hit.Fields["lineStart"]))
			id := archiveID(workspace, path)
			endLine, _ := strconv.Atoi(fmt.Sprint(hit.Fields["lineEnd"]))
			results = append(results, gin.H{"document_id": id, "chunk_id": hit.ID, "corpus_id": archiveID(workspace, filepath.Dir(path)), "title": filepath.Base(path), "path": path, "line_start": line, "line_end": endLine, "text": hit.Fields["text"], "score": hit.Score, "url": fmt.Sprintf("/file/%s?chunk_id=%s", id, hit.ID)})
		}
	}
	c.JSON(200, gin.H{"results": results, "semantic_status": semanticStatus, "semantic_indexed_passages": semanticCoverage})
}

func readDocument(c *gin.Context) {
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
	found := false
	for _, record := range records {
		if record.Path == path {
			found = true
			break
		}
	}
	if !found {
		ErrorHandler(c, fmt.Errorf("document is not indexed"), 404)
		return
	}
	fullPath := filepath.Join(workspace.WorkTree, path)
	resolved, err := filepath.EvalSymlinks(fullPath)
	if err != nil {
		ErrorHandler(c, fmt.Errorf("document is unavailable"), 404)
		return
	}
	if !config.ContainsPath(workspace.WorkTree, resolved) {
		ErrorHandler(c, fmt.Errorf("document escaped its source directory"), 403)
		return
	}
	info, err := os.Lstat(fullPath)
	if err != nil || !info.Mode().IsRegular() {
		ErrorHandler(c, fmt.Errorf("document is not a regular file"), 403)
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
	limit := 32768
	offset := int64(0)
	line := 0
	if value := c.Query("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 4 || limit > 65536 {
			ErrorHandler(c, fmt.Errorf("limit must be 4–65536 bytes"), 400)
			return
		}
	}
	if value := c.Query("offset"); value != "" {
		offset, err = strconv.ParseInt(value, 10, 64)
		if err != nil || offset < 0 || offset > info.Size() {
			ErrorHandler(c, fmt.Errorf("invalid byte offset"), 400)
			return
		}
	}
	if value := c.Query("line"); value != "" {
		line, err = strconv.Atoi(value)
		if err != nil || line < 1 || c.Query("offset") != "" {
			ErrorHandler(c, fmt.Errorf("use either a positive line or byte offset"), 400)
			return
		}
	}
	file, err := os.Open(resolved)
	if err != nil {
		ErrorHandler(c, err, 404)
		return
	}
	defer file.Close()
	if chunkID := c.Query("chunk_id"); chunkID != "" {
		if c.Query("line") != "" || c.Query("offset") != "" {
			ErrorHandler(c, fmt.Errorf("use chunk_id, line, or offset separately"), 400)
			return
		}
		known := false
		for _, record := range records {
			if record.Path == path && record.Id.String() == chunkID {
				known = true
				break
			}
		}
		if !known {
			ErrorHandler(c, fmt.Errorf("passage is not in this document"), 404)
			return
		}
		index, err := bleve.Open(workspace.BleveDir)
		if err != nil {
			ErrorHandler(c, err, 500)
			return
		}
		request := bleve.NewSearchRequestOptions(bleve.NewDocIDQuery([]string{chunkID}), 1, 0, false)
		request.Fields = []string{"text"}
		hits, err := index.Search(request)
		index.Close()
		if err != nil || len(hits.Hits) != 1 {
			ErrorHandler(c, fmt.Errorf("indexed passage is unavailable"), 404)
			return
		}
		pattern, ok := hits.Hits[0].Fields["text"].(string)
		if !ok || pattern == "" {
			ErrorHandler(c, fmt.Errorf("indexed passage has no text"), 404)
			return
		}
		// Find the exact indexed passage with a bounded window, including long lines.
		window := []byte{}
		buffer := make([]byte, 32768)
		position := int64(0)
		matched := false
		for {
			if c.Request.Context().Err() != nil {
				return
			}
			n, readErr := file.Read(buffer)
			window = append(window, buffer[:n]...)
			if at := bytes.Index(window, []byte(pattern)); at >= 0 {
				offset = position + int64(at)
				matched = true
				break
			}
			if readErr != nil {
				if readErr != io.EOF {
					ErrorHandler(c, readErr, 500)
					return
				}
				break
			}
			keep := min(len(pattern)-1, len(window))
			position += int64(len(window) - keep)
			window = append([]byte(nil), window[len(window)-keep:]...)
		}
		if !matched {
			ErrorHandler(c, fmt.Errorf("document changed since indexing; search again after reconciliation"), 409)
			return
		}
		if _, err = file.Seek(0, 0); err != nil {
			ErrorHandler(c, err, 500)
			return
		}
	}
	if line > 1 {
		// Locate a line without buffering the whole document or a huge paragraph.
		buffer := make([]byte, 4096)
		current := 1
		for current < line {
			n, err := file.Read(buffer)
			if err != nil && err != io.EOF {
				ErrorHandler(c, err, 500)
				return
			}
			if n == 0 {
				break
			}
			consumed := n
			for i, b := range buffer[:n] {
				if b == '\n' {
					current++
					if current == line {
						consumed = i + 1
						break
					}
				}
			}
			offset += int64(consumed)
		}
	}
	if _, err = file.Seek(offset, 0); err != nil {
		ErrorHandler(c, err, 500)
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, int64(limit)+4))
	if err != nil {
		ErrorHandler(c, err, 500)
		return
	}
	for len(data) > 0 && !utf8.RuneStart(data[0]) {
		data = data[1:]
		offset++
	}
	if len(data) > limit {
		data = data[:limit]
	}
	for len(data) > 0 && !utf8.Valid(data) {
		start := len(data) - 1
		for start > 0 && !utf8.RuneStart(data[start]) {
			start--
		}
		if utf8.FullRune(data[start:]) {
			ErrorHandler(c, fmt.Errorf("document is no longer valid UTF-8"), 400)
			return
		}
		data = data[:start]
	}
	next := offset + int64(len(data))
	truncated := next < info.Size()
	response := gin.H{"document_id": c.Param("id"), "title": filepath.Base(path), "text": string(data), "offset": offset, "next_offset": next, "truncated": truncated, "total_bytes": info.Size(), "url": "/file/" + c.Param("id")}
	if strings.HasPrefix(c.Request.URL.Path, "/api/") {
		c.JSON(200, response)
		return
	}
	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "no-store")
	response["previous_offset"] = max(int64(0), offset-int64(limit))
	response["has_previous"] = offset > 0
	if err := documentPage.Execute(c.Writer, response); err != nil {
		c.Error(err)
	}
}

var documentPage = template.Must(template.New("document").Parse(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{.title}}</title><style>body{max-width:70rem;margin:2rem auto;padding:0 1rem;font:1rem/1.6 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}nav{display:flex;gap:2rem}</style><h1>{{.title}}</h1><p>Byte {{.offset}} of {{.total_bytes}}. Text is shown as recorded.</p><nav aria-label="Document passages">{{if .has_previous}}<a href="?offset={{.previous_offset}}">Previous passage</a>{{end}}{{if .truncated}}<a href="?offset={{.next_offset}}">Next passage</a>{{end}}</nav><pre>{{.text}}</pre></html>`))

func mergeSearchResults(lexical, semantic *bleve.SearchResult, limit int) *bleve.SearchResult {
	if lexical == nil {
		lexical = &bleve.SearchResult{}
	}
	if semantic == nil {
		if len(lexical.Hits) > limit {
			lexical.Hits = lexical.Hits[:limit]
		}
		return lexical
	}
	scores := map[string]float64{}
	hits := map[string]*search.DocumentMatch{}
	for _, result := range []*bleve.SearchResult{lexical, semantic} {
		for rank, hit := range result.Hits {
			scores[hit.ID] += 1 / float64(60+rank+1)
			hits[hit.ID] = hit
		}
	}
	lexical.Hits = nil
	for id, hit := range hits {
		hit.Score = scores[id]
		lexical.Hits = append(lexical.Hits, hit)
	}
	sort.Slice(lexical.Hits, func(i, j int) bool {
		a, b := lexical.Hits[i], lexical.Hits[j]
		if a.Score == b.Score {
			return strings.Compare(a.ID, b.ID) < 0
		}
		return a.Score > b.Score
	})
	if len(lexical.Hits) > limit {
		lexical.Hits = lexical.Hits[:limit]
	}
	return lexical
}
