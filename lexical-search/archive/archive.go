package archive

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/blevesearch/bleve/v2"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	_ "modernc.org/sqlite"

	"lexical-search/config"
	"lexical-search/mapping"
	"lexical-search/server"
	"lexical-search/sse"
)

var workspaceMutexMap = make(map[string]*sync.Mutex)
var workspaceMutexMapLock sync.Mutex
var workspacesDBInitMutex sync.Mutex

func GetWorkspaceMutex(key string) *sync.Mutex {
	workspaceMutexMapLock.Lock()
	defer workspaceMutexMapLock.Unlock()
	m, ok := workspaceMutexMap[key]
	if !ok {
		m = &sync.Mutex{}
		workspaceMutexMap[key] = m
	}
	return m
}

var workspacesSchema = `
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bleveDir TEXT NOT NULL,
    gitDir TEXT NOT NULL,
    workTree TEXT NOT NULL,
	docCount INTEGER NOT NULL DEFAULT 0,
	archiveDBVersion INTEGER NOT NULL,
	lastIndexedCommit TEXT NOT NULL,
    createdAt DATETIME NOT NULL,
    updatedAt DATETIME NOT NULL
);
`

type WorkspaceRecord struct {
	Id                uuid.UUID `db:"id" json:"id"`
	Name              string    `db:"name" json:"name"`
	BleveDir          string    `db:"bleveDir" json:"bleveDir"`
	GitDir            string    `db:"gitDir" json:"gitDir"`
	WorkTree          string    `db:"workTree" json:"workTree"`
	DocCount          int       `db:"docCount" json:"docCount"`
	ArchiveDBVersion  int       `db:"archiveDBVersion" json:"archiveDBVersion"`
	LastIndexedCommit string    `db:"lastIndexedCommit" json:"lastIndexedCommit"`
	CreatedAt         time.Time `db:"createdAt" json:"createdAt"`
	UpdatedAt         time.Time `db:"updatedAt" json:"updatedAt"`
}

func (wsr *WorkspaceRecord) ToWorkspace() server.Workspace {
	return server.Workspace{
		Id:                wsr.Id,
		Name:              wsr.Name,
		BleveDir:          wsr.BleveDir,
		GitDir:            wsr.GitDir,
		WorkTree:          wsr.WorkTree,
		DocCount:          wsr.DocCount,
		ArchiveDBVersion:  wsr.ArchiveDBVersion,
		LastIndexedCommit: wsr.LastIndexedCommit,
		CreatedAt:         wsr.CreatedAt,
		UpdatedAt:         wsr.UpdatedAt,
	}
}

func InitWorkspacesDB() *sqlx.DB {
	// Workspace locks cannot serialize initialization across different workspaces.
	workspacesDBInitMutex.Lock()
	defer workspacesDBInitMutex.Unlock()
	log.Println("Initializing database at " + config.WorkspacesDBPath)

	// Create the LexDir if it doesn't exist
	err := os.MkdirAll(config.LexDir, 0755)
	if err != nil {
		log.Fatalf("Failed to create directory: %v", err)
	}

	db, err := sqlx.Connect("sqlite", config.WorkspacesDBPath)
	if err != nil {
		log.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		log.Fatal(err)
	}

	_, err = db.Exec(workspacesSchema)
	if err != nil {
		log.Fatalf("Failed to create workspaces table: %v", err)
	}

	// Schema version table creation
	versionSchema := `
    CREATE TABLE IF NOT EXISTS schemaVersion (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL
    );
    `
	_, err = db.Exec(versionSchema)
	if err != nil {
		log.Fatalf("Failed to create schemaVersion table: %v", err)
	}

	// Check and set the schema version
	var currentVersion int
	// id = 1 is the lexical schema. Database may contain other tables with different id.
	err = db.Get(&currentVersion, "SELECT version FROM schemaVersion WHERE id = 1")
	if err != nil && err != sql.ErrNoRows {
		log.Fatalf("Failed to query current schema version: %v", err)
	}

	if err == sql.ErrNoRows {
		// Insert the current schema version if no record exists
		_, err = db.Exec("INSERT INTO schemaVersion (id, version) VALUES (1, ?)", config.WORKSPACE_DB_VERSION)
		if err != nil {
			log.Fatalf("Failed to insert initial schema version: %v", err)
		}
	} else if currentVersion != config.WORKSPACE_DB_VERSION {
		// Panic if the existing schema version doesn't match the expected version
		log.Fatalf("Schema version mismatch: expected %d, found %d", config.WORKSPACE_DB_VERSION, currentVersion)
		// TODO: Add a migration to handle schema version changes
	}

	log.Println("Database initialized.")
	return db
}

type Lines = [2]int
type Chunk struct {
	Lines Lines
	Text  string
}
type Chunks []Chunk

// ChunkFile preserves all UTF-8 text, splitting long paragraphs at rune boundaries.
func ChunkFile(filePath string, chunkLines int) ([]Chunk, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	chunks := []Chunk{}
	buffer := []byte{}
	line, startLine := 1, 1
	fresh := false
	flush := func(overlap bool) {
		if !fresh {
			return
		}
		endLine := line
		if len(buffer) > 0 && buffer[len(buffer)-1] == '\n' {
			endLine--
		}
		chunks = append(chunks, Chunk{Lines: Lines{startLine, endLine}, Text: string(buffer)})
		if overlap {
			offset := len(buffer) - 256
			if offset < 0 {
				offset = 0
			}
			end := len(buffer)
			if end > 0 && buffer[end-1] == '\n' {
				end--
			}
			for i := 0; i < 2; i++ {
				previous := strings.LastIndexByte(string(buffer[:end]), '\n')
				if previous < 0 {
					break
				}
				end = previous
				if i == 1 && end+1 > offset {
					offset = end + 1
				}
			}
			for offset < len(buffer) && !utf8.RuneStart(buffer[offset]) {
				offset++
			}
			buffer = append([]byte(nil), buffer[offset:]...)
			startLine = line - strings.Count(string(buffer), "\n")
		} else {
			buffer = nil
		}
		fresh = false
	}
	for {
		r, size, err := reader.ReadRune()
		if err == io.EOF {
			flush(false)
			return chunks, nil
		}
		if err != nil {
			return nil, err
		}
		if r == utf8.RuneError && size == 1 {
			return nil, fmt.Errorf("non-UTF8 file: %s", filePath)
		}
		if len(buffer)+size > config.MAX_CHUNK_LENGTH {
			flush(true)
		}
		buffer = append(buffer, string(r)...)
		fresh = true
		if r == '\n' {
			line++
		}
		if line-startLine >= chunkLines {
			flush(true)
		}
	}
}

func InitBleveIndex(bleveDirPath string) error {
	log.Println("Initializing Bleve index")

	// create mapping
	mapping, err := mapping.SlidingChunkMapping()
	if err != nil {
		return err
	}

	// create index
	index, err := bleve.New(bleveDirPath, mapping)
	if err != nil {
		return err
	}
	index.Close()

	return nil
}

type FileChunkRecord struct {
	Id        uuid.UUID `db:"id" json:"id"`     // pk
	Path      string    `db:"path" json:"path"` // needs to be indexed
	LineStart int       `db:"lineStart" json:"lineStart"`
	LineEnd   int       `db:"lineEnd" json:"lineEnd"`
}

var fileChunksSchema = `
CREATE TABLE IF NOT EXISTS fileChunks (
	id TEXT PRIMARY KEY,
	path TEXT NOT NULL,
	lineStart INTEGER NOT NULL,
	lineEnd INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_path ON fileChunks(path);
`

// initializes a new db at /my/folder/database.sqlite
func InitArchiveDB(archiveDBPath string) error {
	log.Println("Initializing archive database")

	// Create the LexDir if it doesn't exist
	err := os.MkdirAll(config.LexDir, 0755)
	if err != nil {
		return err
	}

	archiveDB, err := sqlx.Connect("sqlite", archiveDBPath)
	if err != nil {
		return err
	}
	defer func() {
		if archiveDB != nil {
			archiveDB.Close()
		}
	}()

	_, err = archiveDB.Exec(fileChunksSchema)
	if err != nil {
		return err
	}

	return nil
}

func MakeBleveDirPath(workspaceId uuid.UUID) string {
	return filepath.Join(config.LexDir, workspaceId.String(), "index.bleve")
}

func MakeArchiveDBPath(workspaceId uuid.UUID) string {
	return filepath.Join(config.LexDir, workspaceId.String(), "archive.sqlite")
}

func GetWorkspaceById(id string) (*WorkspaceRecord, error) {
	db := InitWorkspacesDB()
	defer db.Close()
	var wsr WorkspaceRecord
	err := db.Get(&wsr, "SELECT * FROM workspaces WHERE id = ?", id)
	if err != nil {
		return nil, err
	}
	return &wsr, nil
}

func DeleteWorkspaceById(id string) error {
	db := InitWorkspacesDB()
	defer db.Close()
	_, err := db.Exec("DELETE FROM workspaces WHERE id = ?", id)
	return err
}

func GetWorkspaces(params server.ListWorkspacesParams) ([]WorkspaceRecord, error) {
	db := InitWorkspacesDB()
	defer db.Close()

	// begin query construction
	query := "SELECT * FROM workspaces WHERE 1=1"
	var args []interface{}

	// filters
	if params.WorkTree != nil {
		workTree := filepath.Clean(*params.WorkTree)
		query += " AND workTree = $1"
		args = append(args, workTree)
	}

	// execute query
	wsrs := []WorkspaceRecord{}
	query = db.Rebind(query)
	if err := db.Select(&wsrs, query, args...); err != nil {
		return nil, err
	}

	return wsrs, nil
}

func GetWorkspaceByWorkTree(workTree string) (*WorkspaceRecord, error) {
	db := InitWorkspacesDB()
	defer db.Close()
	var wsr WorkspaceRecord
	err := db.Get(&wsr, "SELECT * FROM workspaces WHERE workTree = ?", workTree)
	if err != nil {
		return nil, err
	}
	return &wsr, nil
}

func InsertWorkspace(wsr *WorkspaceRecord) error {
	db := InitWorkspacesDB()
	defer db.Close()

	// begin transaction
	tx, err := db.Beginx()
	if err != nil {
		return err
	}

	// insert the workspace record
	query := "INSERT INTO workspaces " +
		"(id, name, bleveDir, gitDir, workTree, docCount, archiveDBVersion, lastIndexedCommit, createdAt, updatedAt) " +
		"VALUES (:id, :name, :bleveDir, :gitDir, :workTree, :docCount, :archiveDBVersion, :lastIndexedCommit, :createdAt, :updatedAt)"

	_, err = tx.NamedExec(query, wsr)
	if err != nil {
		tx.Rollback()
		return err
	}

	// commit transaction
	if err := tx.Commit(); err != nil {
		return err
	}

	return nil
}

func updateLastIndexedCommit(wsr *WorkspaceRecord, lastIndexedCommit string) error {
	db := InitWorkspacesDB()
	defer db.Close()
	wsr.LastIndexedCommit = lastIndexedCommit
	wsr.UpdatedAt = time.Now()
	_, err := db.Exec("UPDATE workspaces SET lastIndexedCommit = ?, updatedAt = ? WHERE id = ?", wsr.LastIndexedCommit, wsr.UpdatedAt, wsr.Id)
	return err
}

func updateWorkspaceBleveDir(wsr *WorkspaceRecord, bleveDir string) error {
	db := InitWorkspacesDB()
	defer db.Close()
	wsr.BleveDir = bleveDir
	wsr.UpdatedAt = time.Now()
	_, err := db.Exec("UPDATE workspaces SET bleveDir = ?, updatedAt = ? WHERE id = ?", wsr.BleveDir, wsr.UpdatedAt, wsr.Id)
	return err
}

func updateWorkspaceDocCount(wsr *WorkspaceRecord, docCount uint64) error {
	db := InitWorkspacesDB()
	defer db.Close()
	wsr.DocCount = int(docCount)
	wsr.UpdatedAt = time.Now()
	_, err := db.Exec("UPDATE workspaces SET docCount = ?, updatedAt = ? WHERE id = ?", wsr.DocCount, wsr.UpdatedAt, wsr.Id)
	return err
}

func ArchiveUpdateEventGenerator(ctx context.Context, wsr *WorkspaceRecord, eventChan chan sse.Event, errChan chan error, wg *sync.WaitGroup) {
	log.Println("ArchiveUpdateEventGenerator")
	// Ensure that the waitgroup counter is decremented when this goroutine completes
	defer wg.Done()
	emit := func(event sse.Event) {
		select {
		case eventChan <- event:
		case <-ctx.Done():
		}
	}
	fail := func(err error) {
		select {
		case errChan <- err:
		case <-ctx.Done():
		}
	}
	mutex := GetWorkspaceMutex(wsr.WorkTree)
	mutex.Lock()
	defer mutex.Unlock()
	current, err := GetWorkspaceById(wsr.Id.String())
	if err != nil {
		fail(err)
		return
	}
	wsr = current
	if ctx.Err() != nil {
		return
	}

	// check if we're building from scratch
	if wsr.BleveDir == "" {
		emit(sse.Event{
			SSEName: "updates.message",
			SSEData: "Building archive from scratch",
		})

		// initialize a new bleve index
		bleveDir := MakeBleveDirPath(wsr.Id)
		err := InitBleveIndex(bleveDir)
		if err != nil {
			fail(err)
			return
		}

		// update the workspace record
		err = updateWorkspaceBleveDir(wsr, bleveDir)
		if err != nil {
			fail(err)
			return
		}

		// initialize a new archive db
		archiveDBPath := MakeArchiveDBPath(wsr.Id)
		err = InitArchiveDB(archiveDBPath)
		if err != nil {
			fail(err)
			return
		}
	}

	// determine which files need (re)indexing
	latestCommit, files, err := CheckpointLatest(ctx, wsr.GitDir, wsr.WorkTree, wsr.LastIndexedCommit)
	if err != nil {
		fail(err)
		return
	}
	log.Println("Checkpointed latest")

	// open the archive db and bleve index
	archiveDBPath := MakeArchiveDBPath(wsr.Id)
	archiveDB, err := sqlx.Connect("sqlite", archiveDBPath)
	if err != nil {
		fail(err)
		return
	}
	defer func() {
		if archiveDB != nil {
			archiveDB.Close()
		}
	}()

	index, err := bleve.Open(wsr.BleveDir)
	if err != nil {
		fail(err)
		return
	}
	defer func() {
		if index != nil {
			index.Close()
		}
	}()
	if err = ensureIngestionDB(archiveDB); err != nil {
		fail(err)
		return
	}
	files, fingerprints, err := reconcileFiles(ctx, wsr, archiveDB, index, files)
	if err != nil {
		fail(err)
		return
	}
	if len(files) == 0 {
		return
	}

	// begin processing files
	emit(sse.Event{
		SSEName: "updates.message",
		SSEData: fmt.Sprintf("Updating archive: %s", wsr.WorkTree),
	})
	numFiles := len(files)

	// Publish one source at a time; slow extraction does not delay other reads.
	nFilesAcc := 0
	nDocsAcc := 0
	for _, file := range files {
		log.Println("Processing file", file)

		select {
		case <-ctx.Done():
			log.Println("Context cancelled, cleaning up")
			return
		default: // process one source
			// chunk the files
			newRecords := make([]FileChunkRecord, 0)
			newDocs := make([]server.Document, 0)
			var textPath, textHash string
			var chunks []Chunk
			prepared := ""
			nFilesAcc++
			var owner int
			if err := archiveDB.Get(&owner, "SELECT job_pid FROM ingestion WHERE path=?", file); err != nil && err != sql.ErrNoRows {
				fail(err)
				return
			}
			if owner != 0 {
				continue
			}
			if fingerprints[file] == "" {
				if _, err := archiveDB.Exec("DELETE FROM ingestion WHERE path=?", file); err != nil {
					fail(err)
					return
				}
				if NeedsExtraction(file) {
					if err := os.Remove(TextPath(wsr, file)); err != nil && !os.IsNotExist(err) {
						fail(err)
						return
					}
				}
			} else {
				if NeedsExtraction(file) {
					claimed, claimErr := claimExtraction(archiveDB, wsr, file)
					if claimErr != nil {
						fail(claimErr)
						return
					}
					if !claimed {
						continue
					}
					// On any early return, release our claim while still holding the
					// workspace mutex. Completed jobs already have job_pid=0.
					defer func(path string) {
						db, err := sqlx.Connect("sqlite", archiveDBPath)
						if err != nil {
							log.Printf("Cannot release extraction job %s: %v", path, err)
							return
						}
						defer db.Close()
						var owner int
						if err := db.Get(&owner, "SELECT job_pid FROM ingestion WHERE path=?", path); err != nil || owner != os.Getpid() {
							return
						}
						if err := os.RemoveAll(jobDirectory(wsr, path)); err != nil {
							log.Printf("Cannot clean extraction job %s: %v", path, err)
							return
						}
						_, err = db.Exec("UPDATE ingestion SET job_pid=0,error='interrupted extraction; retry' WHERE path=? AND job_pid=?", path, os.Getpid())
						if err != nil {
							log.Printf("Cannot release extraction job %s: %v", path, err)
							return
						}

					}(file)
					// Close Bleve's writer handle too: releasing just the mutex would
					// still prevent retrieval from opening the index during extraction.
					if closeErr := index.Close(); closeErr != nil {
						fail(closeErr)
						return
					}
					index = nil
					if closeErr := archiveDB.Close(); closeErr != nil {
						fail(closeErr)
						return
					}
					archiveDB = nil
					mutex.Unlock()
					textPath, textHash, err = prepareText(ctx, wsr, file, fingerprints[file])
					if err == nil {
						chunks, err = ChunkFile(textPath, config.FILE_CHUNK_LINES)
					}
					mutex.Lock()
					var openErr error
					archiveDB, openErr = sqlx.Connect("sqlite", archiveDBPath)
					if openErr != nil {
						fail(openErr)
						return
					}
					index, openErr = bleve.Open(wsr.BleveDir)
					if openErr != nil {
						fail(openErr)
						return
					}
					if err == nil {
						prepared = textPath
					}
				} else {
					textPath, textHash, err = prepareText(ctx, wsr, file, fingerprints[file])
					if err == nil {
						chunks, err = ChunkFile(textPath, config.FILE_CHUNK_LINES)
					}
				}
				if err != nil {
					log.Printf("Cannot ingest %s: %v", filepath.Join(wsr.WorkTree, file), err)
					if NeedsExtraction(file) {
						if cleanupErr := os.RemoveAll(jobDirectory(wsr, file)); cleanupErr != nil {
							fail(cleanupErr)
							return
						}
					}
					if _, dbErr := archiveDB.Exec("INSERT INTO ingestion(path, fingerprint, version, chunks, text_hash, error) VALUES (?, ?, ?, 0, '', ?) ON CONFLICT(path) DO UPDATE SET error=excluded.error, job_pid=0", file, fingerprints[file], extractionVersion(file), err.Error()); dbErr != nil {
						fail(dbErr)
						return
					}

					continue
				}

				// append the new db records and bleve docs
				for _, chunk := range chunks {
					nDocsAcc++

					newRecord := FileChunkRecord{
						Id:        uuid.New(),
						Path:      file,
						LineStart: chunk.Lines[0],
						LineEnd:   chunk.Lines[1],
					}
					newRecords = append(newRecords, newRecord)

					newDoc := server.Document{
						Id:        newRecord.Id,
						LineEnd:   strconv.Itoa(chunk.Lines[1]),
						LineStart: strconv.Itoa(chunk.Lines[0]),
						Path:      file,
						Text:      chunk.Text,
					}
					newDocs = append(newDocs, newDoc)
				}
			}
			if prepared != "" {
				if err := os.Rename(prepared, TextPath(wsr, file)); err != nil {
					fail(err)
					return
				}
			}
			// read records from the archive db
			var existingRecords []FileChunkRecord
			if err := archiveDB.Select(&existingRecords, "SELECT * FROM fileChunks WHERE path=?", file); err != nil {
				fail(err)
				return
			}

			log.Printf("Found %d existing records", len(existingRecords))
			if len(existingRecords) > 0 {
				// drop the existing archive db records in one transaction
				docIds := make([]string, len(existingRecords))
				for i, record := range existingRecords {
					docIds[i] = record.Id.String()
				}
				tx, err := archiveDB.Beginx()
				if err != nil {
					fail(err)
					return
				}

				query, args, err := sqlx.In("DELETE FROM fileChunks WHERE id IN (?)", docIds)
				if err != nil {
					tx.Rollback()
					fail(err)
					return
				}

				query = tx.Rebind(query)
				_, err = tx.Exec(query, args...)
				if err != nil {
					tx.Rollback()
					fail(err)
					return
				}
				err = tx.Commit()
				if err != nil {
					fail(err)
					return
				}

				// drop the existing records from the bleve index
				batchOp := index.NewBatch()
				for _, docId := range docIds {
					batchOp.Delete(docId)
				}
				err = index.Batch(batchOp)
				if err != nil {
					fail(err)
					return
				}
			}

			if len(newRecords) > 0 {
				tx, err := archiveDB.Beginx()
				if err != nil {
					fail(err)
					return
				}

				batchSize := 512 // don't exceed SQLite's max number of variables per query
				for i := 0; i < len(newRecords); i += batchSize {
					end := i + batchSize
					if end > len(newRecords) {
						end = len(newRecords)
					}

					_, err = tx.NamedExec("INSERT INTO fileChunks (id, path, lineStart, lineEnd) VALUES (:id, :path, :lineStart, :lineEnd)", newRecords[i:end])
					if err != nil {
						log.Println("Error inserting records:", err)
						tx.Rollback()
						fail(err)
						return
					}
				}

				err = tx.Commit()
				if err != nil {
					fail(err)
					return
				}
			}

			if len(newDocs) > 0 {
				log.Println("Indexing new Bleve docs:", len(newDocs))
				// bulk insert the new docs into the bleve index
				batchOp := index.NewBatch()
				for _, doc := range newDocs {
					batchOp.Index(doc.Id.String(), doc)
				}
				err = index.Batch(batchOp)
				if err != nil {
					fail(err)
					return
				}
				log.Println("Indexed new Bleve docs:", len(newDocs))
			}

			if NeedsExtraction(file) {
				if err := os.RemoveAll(jobDirectory(wsr, file)); err != nil {
					fail(err)
					return
				}
			}
			if fingerprints[file] != "" {
				if _, err := archiveDB.Exec("INSERT OR REPLACE INTO ingestion(path, fingerprint, version, chunks, text_hash, error) VALUES (?, ?, ?, ?, ?, '')", file, fingerprints[file], extractionVersion(file), len(chunks), textHash); err != nil {
					fail(err)
					return
				}
			}

			emit(sse.Event{
				SSEName: "updates.progress",
				SSEData: fmt.Sprintf("Indexed %d of %d files", nFilesAcc, numFiles),
			})
		}
	}

	// done processing sources

	select {
	case <-ctx.Done():
		log.Println("Context cancelled, cleaning up")
		return
	default: // finalize the update
		// update the workspace doc count
		docCount, err := index.DocCount()
		if err != nil {
			fail(err)
			return
		}

		err = updateWorkspaceDocCount(wsr, docCount)
		if err != nil {
			fail(err)
			return
		}

		// successfully updated the archive for the latest commit
		err = updateLastIndexedCommit(wsr, latestCommit)
		if err != nil {
			fail(err)
		}

		// send the final update summary as json
		summary := sse.UpdateSummaryPayload{
			NumFiles: nFilesAcc,
			NumDocs:  nDocsAcc,
		}
		summaryJson, err := json.Marshal(summary)
		if err != nil {
			fail(err)
			return
		}

		emit(sse.Event{
			SSEName: "updates.summary",
			SSEData: string(summaryJson),
		})
	}

}

func EscapeQuery(query string) string {
	// Characters to be escaped
	specialChars := `+-=&|><!(){}[]^"~*?:\/`

	// Escaping each special character
	var escapedQuery strings.Builder
	for _, char := range query {
		if strings.ContainsRune(specialChars, char) {
			escapedQuery.WriteRune('\\')
		}
		escapedQuery.WriteRune(char)
	}

	return escapedQuery.String()
}
