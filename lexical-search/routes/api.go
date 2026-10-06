package routes

import (
	"context"
	"errors"
	"lexical-search/archive"
	"lexical-search/config"
	"lexical-search/server"
	"lexical-search/sse"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/blevesearch/bleve/v2"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Custom error handler
func ErrorHandler(c *gin.Context, err error, statusCode int) {
	method := c.Request.Method
	path := c.Request.URL.Path

	log.Printf("Error in route %s %s: %s, status code: %d", method, path, err.Error(), statusCode)

	errorsResponse := server.ErrorsResponse{
		Errors: []server.Error{
			{
				Detail: err.Error(),
			},
		},
	}

	c.JSON(statusCode, errorsResponse)
}

func createWorkspace(workTreePath string, name string, lockWorkspace bool) (*archive.WorkspaceRecord, int, error) {

	workTree := filepath.Clean(workTreePath)

	// lock this workspace
	if lockWorkspace {
		m := archive.GetWorkspaceMutex(workTree)
		m.Lock()
		defer m.Unlock()
	}

	// verify that the workTree exists
	info, err := os.Stat(workTree)
	if err != nil {
		return nil, http.StatusBadRequest, err
	}
	if !info.IsDir() {
		return nil, http.StatusBadRequest, errors.New("workTree must be a directory")
	}

	// check if the workspace already exists
	_, err = archive.GetWorkspaceByWorkTree(workTree)
	if err == nil {
		return nil, http.StatusConflict, errors.New("workspace already exists for workTree")
	}

	// create the workspace directory (<lexDir>/<id>)
	id := uuid.New()
	gitDir := filepath.Join(config.LexDir, id.String())
	err = os.MkdirAll(gitDir, 0755)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}

	// create a new workspace record
	wsr := &archive.WorkspaceRecord{
		Id:                id,
		Name:              name,
		BleveDir:          "", // this will be initialized later
		GitDir:            gitDir,
		WorkTree:          workTree,
		DocCount:          0,
		ArchiveDBVersion:  config.ARCHIVE_DB_VERSION,
		LastIndexedCommit: "", // this will be initialized later
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}

	// initialize the git repository
	_, err = archive.InitRepo(wsr.GitDir, wsr.WorkTree)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}

	// insert the workspace record
	err = archive.InsertWorkspace(wsr)
	if err != nil {
		log.Println("Error inserting workspace:", err, wsr)
		return nil, http.StatusInternalServerError, err
	}
	return wsr, http.StatusOK, nil
}

func deleteWorkspace(workspaceId string, lockWorkspace bool) (int, error) {
	// check if the workspace exists
	wsr, err := archive.GetWorkspaceById(workspaceId)
	if err != nil {
		return http.StatusNotFound, errors.New("workspace not found")
	}

	// lock this workspace
	if lockWorkspace {
		m := archive.GetWorkspaceMutex(wsr.WorkTree)
		m.Lock()
		defer m.Unlock()
	}

	// Delete the git directory
	if err := os.RemoveAll(wsr.GitDir); err != nil {
		return http.StatusInternalServerError, err
	}
	// begin transaction
	err = archive.DeleteWorkspaceById(wsr.Id.String())
	if err != nil {
		log.Println("Error deleting workspace:", err, wsr)
		return http.StatusInternalServerError, err
	}

	return http.StatusOK, nil
}

// Helper function to ensure a workspace exists by ID or workTree
func ensureWorkspaceExists(workspaceId, workTree string) (*archive.WorkspaceRecord, error) {
	var wsr *archive.WorkspaceRecord
	var err error
	var status int

	if workspaceId != "" {
		wsr, err = archive.GetWorkspaceById(workspaceId)
		if err != nil {
			return nil, errors.New("workspace not found")
		}
	} else if workTree != "" {
		wsr, err = archive.GetWorkspaceByWorkTree(workTree)
		if err != nil {
			// If the workspace does not exist, create it
			wsr, status, err = createWorkspace(workTree, filepath.Base(workTree), false)
			if err != nil {
				return nil, err
			}
			if status != http.StatusOK {
				return nil, errors.New("failed to create workspace")
			}
		}
	} else {
		return nil, errors.New("either workspaceId or workTree must be provided")
	}

	// Lock the workspace
	m := archive.GetWorkspaceMutex(wsr.WorkTree)
	m.Lock()
	defer m.Unlock()

	// Check if the BleveDir or GitDir exists
	_, errBleve := os.Stat(wsr.BleveDir)
	_, errGit := os.Stat(wsr.GitDir)
	if (wsr.BleveDir != "" && os.IsNotExist(errBleve)) || os.IsNotExist(errGit) {
		log.Println("Recreating workspace:", wsr.Id.String())
		log.Println("BleveDir exists:", !os.IsNotExist(errBleve))
		log.Println("GitDir exists:", !os.IsNotExist(errGit))

		// Recreate workspace if necessary
		status, err := deleteWorkspace(wsr.Id.String(), false)
		if err != nil {
			return nil, err
		}
		if status != http.StatusOK {
			return nil, errors.New("failed to delete workspace")
		}
		wsr, status, err = createWorkspace(wsr.WorkTree, wsr.Name, false)
		if err != nil {
			return nil, err
		}
		if status != http.StatusOK {
			return nil, errors.New("failed to recreate workspace")
		}
	}

	// Check if the workspace archive DB is the correct version
	if wsr.ArchiveDBVersion != config.ARCHIVE_DB_VERSION {
		return nil, errors.New("the workspace archive db is outdated")
	}

	return wsr, nil
}

// Helper function to get all relevant workspaces
func getAllRelevantWorkspaces(body server.SearchRequest) ([]*archive.WorkspaceRecord, error) {
	var workspaces []*archive.WorkspaceRecord

	// Ensure the primary workspace exists
	primaryWorkspace, err := archive.GetWorkspaceById(body.Id)
	if err != nil {
		return nil, errors.New("primary workspace not found")
	}
	workspaces = append(workspaces, primaryWorkspace)

	// Ensure all folders in the provided databases exist as workspaces
	for _, db := range body.Databases {
		for _, folder := range db.Folders {
			wsr, err := ensureWorkspaceExists("", folder)
			if err != nil {
				return nil, err
			}
			workspaces = append(workspaces, wsr)
		}
	}

	return workspaces, nil
}

type Api struct{}

// Search an index
// (POST /search)
func (api *Api) Search(c *gin.Context) {
	log.Println("Search")

	// get request body
	var body server.SearchRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		ErrorHandler(c, err, http.StatusBadRequest)
		return
	}

	// Initialize a list to hold all workspace records
	workspaces, err := getAllRelevantWorkspaces(body)
	if err != nil {
		ErrorHandler(c, err, http.StatusNotFound)
		return
	}

	// Serialize each index's open lifetime with updates; stable order avoids deadlocks.
	sort.Slice(workspaces, func(i, j int) bool { return workspaces[i].WorkTree < workspaces[j].WorkTree })
	unique := workspaces[:0]
	for _, workspace := range workspaces {
		if len(unique) > 0 && unique[len(unique)-1].WorkTree == workspace.WorkTree {
			continue
		}
		m := archive.GetWorkspaceMutex(workspace.WorkTree)
		m.Lock()
		defer m.Unlock()
		current, err := archive.GetWorkspaceById(workspace.Id.String())
		if err != nil {
			ErrorHandler(c, err, http.StatusNotFound)
			return
		}
		unique = append(unique, current)
	}
	workspaces = unique

	// Create a Bleve alias to include all relevant indexes
	alias := bleve.NewIndexAlias()
	hasIndexes := false // Track if any index has been opened

	for _, wsr := range workspaces {
		if wsr.BleveDir == "" {
			continue
		}

		// open index
		log.Println("Opening index file:", wsr.BleveDir)
		index, err := bleve.Open(wsr.BleveDir)
		if err != nil {
			if errors.Is(err, bleve.ErrorIndexPathDoesNotExist) {
				ErrorHandler(c, err, http.StatusNotFound)
			} else {
				ErrorHandler(c, err, http.StatusInternalServerError)
			}
			return
		}

		// Defer closing of the index
		defer index.Close()
		alias.Add(index)
		hasIndexes = true
	}
	// If no indexes were added, return a meaningful response
	if !hasIndexes {
		c.JSON(http.StatusNotFound, gin.H{"error": "No indexes found for search"})
		return
	}

	// Perform the search using the alias
	log.Println("Searching...")
	startTime := time.Now()
	escaped := archive.EscapeQuery(body.Query)
	searchQuery := bleve.NewQueryStringQuery(escaped)
	searchRequest := bleve.NewSearchRequestOptions(searchQuery, body.Limit, 0, false)
	searchRequest.Fields = []string{"path", "lineStart", "lineEnd", "text"}
	searchResult, err := alias.Search(searchRequest)
	if err != nil {
		ErrorHandler(c, err, http.StatusInternalServerError)
		return
	}
	duration := time.Since(startTime)
	log.Printf("Found %d documents in %s\n", searchResult.Total, duration)
	// Collect results
	results := []server.SearchResult{}
	for _, hit := range searchResult.Hits {
		parsedUUID, err := uuid.Parse(hit.ID)
		if err != nil {
			ErrorHandler(c, err, http.StatusInternalServerError)
			return
		}
		doc := server.Document{
			Id:        parsedUUID,
			LineEnd:   hit.Fields["lineEnd"].(string),
			LineStart: hit.Fields["lineStart"].(string),
			Path:      hit.Fields["path"].(string),
			Text:      hit.Fields["text"].(string),
		}
		resultItem := server.SearchResult{
			Document: doc,
			Score:    float32(hit.Score),
		}
		results = append(results, resultItem)
	}

	// Create response
	response := server.SearchResponse{
		Results: results,
	}

	// Send response
	c.JSON(http.StatusOK, response)
}

// Stream archive updates (SSE) for a workspace
// (GET /updates)
func (api *Api) StreamUpdates(c *gin.Context, params server.StreamUpdatesParams) {
	log.Println("StreamUpdates")
	// Bind the request body to the StreamUpdatesRequest struct
	var req []server.MontyDatabase
	if err := c.ShouldBindJSON(&req); err != nil {
		ErrorHandler(c, err, http.StatusBadRequest)
		return
	}

	// Queue to hold all workspace records
	var workspaceQueue []*archive.WorkspaceRecord

	// Ensure the primary workspace exists
	wsr, err := ensureWorkspaceExists(params.Id.String(), "")
	if err != nil {
		ErrorHandler(c, err, http.StatusNotFound)
		return
	}
	workspaceQueue = append(workspaceQueue, wsr)

	// Ensure all folders in the provided databases exist as workspaces
	for _, db := range req {
		for _, folder := range db.Folders {
			wsr, err := ensureWorkspaceExists("", folder)
			if err != nil {
				ErrorHandler(c, err, http.StatusInternalServerError)
				return
			}
			workspaceQueue = append(workspaceQueue, wsr)
		}
	}

	// Initialize event and error channels
	eventChan := make(chan sse.Event)
	errChan := make(chan error)
	// Initialize waitgroup
	var wg sync.WaitGroup

	// Set necessary headers for SSE
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")

	// Create a flusher
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		ErrorHandler(c, errors.New("streaming unsupported"), http.StatusInternalServerError)
		return
	}

	// Start the event generators for all workspaces in the queue
	streamContext, cancel := context.WithCancel(c.Request.Context())
	defer cancel()
	for _, wsr := range workspaceQueue {
		wg.Add(1)
		go archive.ArchiveUpdateEventGenerator(streamContext, wsr, eventChan, errChan, &wg)
	}
	// Defer closing the channels, but only after all goroutines have finished
	go func() {
		wg.Wait()
		close(eventChan)
		close(errChan)
	}()

	// Listen for events and send them to the client
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case event, ok := <-eventChan:
			if !ok {
				return // Exit the loop if the channel is closed
			}
			sse.EventTemplate.Execute(c.Writer, event)
			flusher.Flush()
		case err, ok := <-errChan:
			if !ok {
				return // Exit the loop if the channel is closed
			}
			event := sse.Event{
				SSEName: "error",
				SSEData: err.Error(),
			}
			sse.EventTemplate.Execute(c.Writer, event)
			flusher.Flush()
			return
		}
	}
}

// Delete a workspace if it exists
// (DELETE /workspaces)
func (api *Api) DeleteWorkspace(c *gin.Context) {
	log.Println("DeleteWorkspace")
	// get request body
	var body server.DeleteWorkspaceRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		ErrorHandler(c, err, http.StatusBadRequest)
		return
	}
	// delete the workspace
	if status, err := deleteWorkspace(body.Id.String(), true); err != nil {
		ErrorHandler(c, err, status)
		return
	}

	// send response
	c.JSON(http.StatusNoContent, nil)
}

// Returns a list of workspaces
// (GET /workspaces)
func (api *Api) ListWorkspaces(c *gin.Context, params server.ListWorkspacesParams) {
	log.Println("ListWorkspaces")

	// get workspaces
	wsrs, err := archive.GetWorkspaces(params)
	if err != nil {
		log.Println("Error getting workspaces:", err, params)
		ErrorHandler(c, err, http.StatusInternalServerError)
		return
	}
	if len(wsrs) == 0 {
		ErrorHandler(c, errors.New("no workspaces found"), http.StatusNotFound)
		return
	}

	// create response
	workspaces := make([]server.Workspace, len(wsrs))
	for i, wsr := range wsrs {
		workspaces[i] = wsr.ToWorkspace()
	}
	response := &server.WorkspacesResponse{
		Workspaces: workspaces,
	}

	// send response
	c.JSON(http.StatusOK, response)

}

// Create a new workspace
// (POST /workspaces)
func (api *Api) CreateWorkspace(c *gin.Context) {
	log.Println("CreateWorkspace")
	// get request body
	var body server.CreateWorkspaceRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		ErrorHandler(c, err, http.StatusBadRequest)
		return
	}
	// create the workspace
	wsr, status, err := createWorkspace(body.WorkTree, body.Name, true)
	if err != nil {
		ErrorHandler(c, err, status)
		return
	}

	// create response
	response := &server.WorkspacesResponse{
		Workspaces: []server.Workspace{
			wsr.ToWorkspace(),
		},
	}

	// send response
	c.JSON(http.StatusCreated, response)
}
