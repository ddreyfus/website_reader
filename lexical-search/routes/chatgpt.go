package routes

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jmoiron/sqlx"
)

// Inventory and jobs share a row: rediscovery cannot create duplicate work.
const chatGPTSchema = `
CREATE TABLE IF NOT EXISTS chatgpt_projects(scope TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,PRIMARY KEY(scope,id));
CREATE TABLE IF NOT EXISTS chatgpt_conversations(
 scope TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,project_id TEXT NOT NULL DEFAULT '',url TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 1,saved_generation INTEGER NOT NULL DEFAULT 0,
 lease TEXT NOT NULL DEFAULT '',leased_generation INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,
 content_hash TEXT NOT NULL DEFAULT '',saved_at INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(scope,id));
CREATE TABLE IF NOT EXISTS chatgpt_checkpoints(scope TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,key));
CREATE TABLE IF NOT EXISTS chatgpt_pages(scope TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,cursor TEXT NOT NULL,next_cursor TEXT,body TEXT NOT NULL,PRIMARY KEY(scope,id,generation,cursor));`

var chatGPTID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Caller owns db lifetime. Reuse the service's SQLite driver and archive root;
// never accept a destination path supplied by a browser page.
func RegisterChatGPTHandlers(router *gin.Engine, db *sqlx.DB, root string) error {
	if _, err := db.Exec(chatGPTSchema); err != nil {
		return err
	}
	var hasUpdatedAt int
	if err := db.Get(&hasUpdatedAt, `SELECT COUNT(*) FROM pragma_table_info('chatgpt_conversations') WHERE name='remote_updated_at'`); err != nil {
		return err
	}
	if hasUpdatedAt == 0 {
		if _, err := db.Exec(`ALTER TABLE chatgpt_conversations ADD COLUMN remote_updated_at TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
	}
	group := router.Group("/api/v1/chatgpt")
	group.Use(func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && !strings.HasPrefix(origin, "chrome-extension://") {
			c.AbortWithStatusJSON(403, gin.H{"error": "ChatGPT backups require an extension or local client"})
			return
		}
		c.Header("Cache-Control", "no-store")
	})
	group.GET("/status", func(c *gin.Context) {
		scope := c.Query("scope")
		var inventoryRaw string
		var inventory map[string]interface{}
		if err := db.Get(&inventoryRaw, `SELECT value FROM chatgpt_checkpoints WHERE scope=? AND key='inventory'`, scope); err == nil {
			json.Unmarshal([]byte(inventoryRaw), &inventory)
		}
		rows := []map[string]interface{}{}
		result, err := db.Queryx(`SELECT id,title,project_id,url,generation,saved_generation,content_hash,saved_at,error,lease_until FROM chatgpt_conversations WHERE scope=? ORDER BY title,id`, scope)
		if err == nil {
			defer result.Close()
			for result.Next() {
				row := map[string]interface{}{}
				if err = result.MapScan(row); err != nil {
					break
				}
				rows = append(rows, row)
			}
			if err == nil {
				err = result.Err()
			}
		}
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"conversations": rows, "root": root, "coverage": "conversation JSON pages; alternate branches and attachment files are not verified", "inventory_complete": inventory["complete"] == true, "inventory_completed_at": inventory["completedAt"]})
	})
	group.GET("/checkpoint", func(c *gin.Context) {
		var value json.RawMessage
		var raw string
		err := db.Get(&raw, `SELECT value FROM chatgpt_checkpoints WHERE scope=? AND key='inventory'`, c.Query("scope"))
		if err != nil && err != sql.ErrNoRows {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		if err == nil {
			value = json.RawMessage(raw)
		}
		projects := map[string]string{}
		rows, err := db.Queryx(`SELECT id,title FROM chatgpt_projects WHERE scope=?`, c.Query("scope"))
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		defer rows.Close()
		for rows.Next() {
			var id, title string
			if err := rows.Scan(&id, &title); err != nil {
				c.JSON(500, gin.H{"error": err.Error()})
				return
			}
			projects[id] = title
		}
		if err := rows.Err(); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"checkpoint": value, "projects": projects})
	})
	group.POST("/:action", func(c *gin.Context) {
		if strings.Split(c.GetHeader("Content-Type"), ";")[0] != "application/json" {
			c.JSON(415, gin.H{"error": "application/json required"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<20)
		var input struct {
			Projects      map[string]string `json:"projects"`
			Scope         string            `json:"scope"`
			ID            string            `json:"id"`
			Lease         string            `json:"lease"`
			Generation    int64             `json:"generation"`
			Error         string            `json:"error"`
			RetrySeconds  int64             `json:"retry_seconds"`
			Cursor        string            `json:"cursor"`
			Page          json.RawMessage   `json:"page"`
			Checkpoint    json.RawMessage   `json:"checkpoint"`
			Conversations []struct {
				ID           string `json:"id"`
				Title        string `json:"title"`
				ProjectID    string `json:"project_id"`
				ProjectTitle string `json:"project_title"`
				UpdatedAt    string `json:"updated_at"`
			} `json:"conversations"`
			Snapshot json.RawMessage `json:"snapshot"`
		}
		if err := c.ShouldBindJSON(&input); err != nil || !chatGPTID.MatchString(input.Scope) {
			c.JSON(400, gin.H{"error": "valid scope and JSON required"})
			return
		}
		now := time.Now().Unix()
		started := time.Now()
		defer func() {
			log.Printf("chatgpt_backup action=%q scope=%q conversation_id=%q generation=%d discovered=%d status=%d elapsed_ms=%d", c.Param("action"), input.Scope, input.ID, input.Generation, len(input.Conversations), c.Writer.Status(), time.Since(started).Milliseconds())
		}()
		tx, err := db.Beginx()
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		defer tx.Rollback()
		fail := func(err error) {
			log.Printf("chatgpt_backup action=%q scope=%q conversation_id=%q error=%q", c.Param("action"), input.Scope, input.ID, err)
			c.JSON(500, gin.H{"error": err.Error()})
		}
		switch c.Param("action") {
		case "event":
			log.Printf("chatgpt_backup progress scope=%q message=%q", input.Scope, input.Error[:min(len(input.Error), 1024)])
		case "discover":
			for id, title := range input.Projects {
				if !strings.HasPrefix(id, "g-p-") || !chatGPTID.MatchString(id) || len(title) > 2048 {
					c.JSON(400, gin.H{"error": "invalid project identity or title"})
					return
				}
				if _, err = tx.Exec(`INSERT INTO chatgpt_projects(scope,id,title) VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET title=excluded.title`, input.Scope, id, title); err != nil {
					fail(err)
					return
				}
			}
			if len(input.Conversations) > 1000 {
				c.JSON(400, gin.H{"error": "at most 1000 conversations per batch"})
				return
			}
			for _, item := range input.Conversations {
				if !chatGPTID.MatchString(item.ID) || (item.ProjectID != "" && !chatGPTID.MatchString(item.ProjectID)) || len(item.Title) > 2048 || len(item.ProjectTitle) > 2048 {
					c.JSON(400, gin.H{"error": "invalid conversation identity or title"})
					return
				}
				if item.ProjectID != "" {
					_, err = tx.Exec(`INSERT INTO chatgpt_projects(scope,id,title) VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET title=CASE WHEN excluded.title='' THEN title ELSE excluded.title END`, input.Scope, item.ProjectID, item.ProjectTitle)
					if err != nil {
						fail(err)
						return
					}
				}
				url := "https://chatgpt.com/c/" + item.ID
				if item.ProjectID != "" {
					url = "https://chatgpt.com/g/" + item.ProjectID + "/c/" + item.ID
				}
				_, err = tx.Exec(`INSERT INTO chatgpt_conversations(scope,id,title,project_id,url,remote_updated_at) VALUES(?,?,?,?,?,?)
ON CONFLICT(scope,id) DO UPDATE SET title=excluded.title,project_id=excluded.project_id,url=excluded.url,
generation=CASE WHEN title!=excluded.title OR project_id!=excluded.project_id OR (excluded.remote_updated_at!='' AND remote_updated_at!=excluded.remote_updated_at) THEN generation+1 ELSE generation END,
remote_updated_at=CASE WHEN excluded.remote_updated_at='' THEN remote_updated_at ELSE excluded.remote_updated_at END`, input.Scope, item.ID, item.Title, item.ProjectID, url, item.UpdatedAt)
				if err != nil {
					fail(err)
					return
				}
			}
			if len(input.Checkpoint) > 0 {
				_, err = tx.Exec(`INSERT INTO chatgpt_checkpoints(scope,key,value) VALUES(?,'inventory',?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value`, input.Scope, string(input.Checkpoint))
			}
		case "recheck":
			// Until remote update timestamps are verified, recheck saved content daily
			// rather than invalidating every snapshot on each five-minute scan.
			_, err = tx.Exec(`UPDATE chatgpt_conversations SET generation=generation+1,retry_at=0 WHERE scope=? AND saved_generation=generation AND saved_at<=? AND remote_updated_at=''`, input.Scope, now-86400)
		case "claim":
			token := make([]byte, 24)
			if _, err = rand.Read(token); err != nil {
				fail(err)
				return
			}
			lease := hex.EncodeToString(token)
			row := map[string]interface{}{}
			result := tx.QueryRowx(`UPDATE chatgpt_conversations SET lease=?,lease_until=?,leased_generation=generation WHERE rowid=(SELECT rowid FROM chatgpt_conversations WHERE scope=? AND generation>saved_generation AND retry_at<=? AND lease_until<=? ORDER BY retry_at,saved_at,id LIMIT 1) RETURNING id,title,project_id,url,generation`, lease, now+120, input.Scope, now, now)
			if err = result.MapScan(row); err == sql.ErrNoRows {
				c.JSON(200, gin.H{"job": nil})
				return
			}
			if err != nil {
				fail(err)
				return
			}
			if err = tx.Commit(); err != nil {
				fail(err)
				return
			}
			row["lease"] = lease
			log.Printf("chatgpt_backup claimed scope=%q conversation_id=%q generation=%v lease_seconds=120", input.Scope, row["id"], row["generation"])
			c.JSON(200, gin.H{"job": row})
			return
		case "save", "fail", "restart", "verify", "yield", "page", "pages", "complete":
			var generation, claimedGeneration int64
			var title, url string
			err = tx.QueryRow(`SELECT generation,leased_generation,title,url FROM chatgpt_conversations WHERE scope=? AND id=? AND lease=? AND lease_until>?`, input.Scope, input.ID, input.Lease, now).Scan(&generation, &claimedGeneration, &title, &url)
			if err == sql.ErrNoRows {
				c.JSON(409, gin.H{"error": "job lease expired or replaced"})
				return
			}
			if err != nil {
				fail(err)
				return
			}
			if c.Param("action") == "pages" {
				cursor, count, done, err := chatGPTPageCursor(tx, input.Scope, input.ID, claimedGeneration)
				if err != nil {
					fail(err)
					return
				}
				c.JSON(200, gin.H{"cursor": cursor, "pages": count, "complete": done})
				return
			}
			if c.Param("action") == "verify" {
				var previous string
				if err := tx.Get(&previous, `SELECT body FROM chatgpt_pages WHERE scope=? AND id=? AND generation=? AND cursor=''`, input.Scope, input.ID, claimedGeneration); err != nil {
					fail(err)
					return
				}
				var oldPage, newPage map[string]interface{}
				if json.Unmarshal([]byte(previous), &oldPage) != nil || json.Unmarshal(input.Page, &newPage) != nil {
					c.JSON(400, gin.H{"error": "invalid verification page"})
					return
				}
				oldHead, _ := json.Marshal([]interface{}{oldPage["current_node"], oldPage["messages"]})
				newHead, _ := json.Marshal([]interface{}{newPage["current_node"], newPage["messages"]})
				c.JSON(200, gin.H{"matches": string(oldHead) == string(newHead)})
				return
			}
			if c.Param("action") == "page" {
				if input.Generation != claimedGeneration {
					c.JSON(409, gin.H{"error": "page generation does not match lease"})
					return
				}
				err = chatGPTStorePage(tx, input.Scope, input.ID, input.Generation, input.Cursor, input.Page)
				if err == nil {
					_, err = tx.Exec(`UPDATE chatgpt_conversations SET lease_until=? WHERE scope=? AND id=? AND lease=?`, now+120, input.Scope, input.ID, input.Lease)
				}
				if err != nil {
					c.JSON(400, gin.H{"error": err.Error()})
					return
				}
				if err = tx.Commit(); err != nil {
					fail(err)
					return
				}
				log.Printf("chatgpt_backup page_saved scope=%q conversation_id=%q generation=%d bytes=%d", input.Scope, input.ID, input.Generation, len(input.Page))
				c.JSON(200, gin.H{"ok": true})
				return
			}
			if c.Param("action") == "complete" {
				input.Snapshot, err = chatGPTAssemblePages(tx, input.Scope, input.ID, claimedGeneration)
				if err != nil {
					c.JSON(400, gin.H{"error": err.Error()})
					return
				}
			}
			if c.Param("action") == "restart" {
				_, err = tx.Exec(`UPDATE chatgpt_conversations SET generation=CASE WHEN generation=leased_generation THEN generation+1 ELSE generation END,lease='',lease_until=0,retry_at=?,error=? WHERE scope=? AND id=?`, now+60, input.Error[:min(len(input.Error), 1024)], input.Scope, input.ID)
			} else if c.Param("action") == "yield" {
				_, err = tx.Exec(`UPDATE chatgpt_conversations SET lease='',lease_until=0,retry_at=0,error='' WHERE scope=? AND id=?`, input.Scope, input.ID)
			} else if c.Param("action") == "fail" {
				log.Printf("chatgpt_backup retry scope=%q conversation_id=%q retry_seconds=%d error=%q", input.Scope, input.ID, max(60, min(3600, input.RetrySeconds)), input.Error[:min(len(input.Error), 1024)])
				_, err = tx.Exec(`UPDATE chatgpt_conversations SET lease='',lease_until=0,retry_at=?,error=? WHERE scope=? AND id=?`, now+max(60, min(3600, input.RetrySeconds)), input.Error[:min(len(input.Error), 1024)], input.Scope, input.ID)
			} else {
				if input.Generation < 1 || input.Generation > generation || input.Generation != claimedGeneration {
					c.JSON(400, gin.H{"error": "invalid job generation"})
					return
				}
				var snapshot struct {
					ID       string `json:"id"`
					Messages []struct {
						Role string `json:"role"`
						Text string `json:"text"`
					} `json:"messages"`
					Coverage string `json:"coverage"`
				}
				if json.Unmarshal(input.Snapshot, &snapshot) != nil || snapshot.ID != input.ID || len(snapshot.Messages) == 0 || (snapshot.Coverage != "rendered" && snapshot.Coverage != "structured") {
					c.JSON(400, gin.H{"error": "nonempty rendered snapshot with matching id required"})
					return
				}
				var canonical map[string]interface{}
				json.Unmarshal(input.Snapshot, &canonical)
				if snapshot.Coverage == "structured" {
					delete(canonical, "messages")
				}
				raw, _ := json.MarshalIndent(canonical, "", "  ")
				sum := sha256.Sum256(raw)
				hash := hex.EncodeToString(sum[:])
				log.Printf("chatgpt_backup saving scope=%q conversation_id=%q generation=%d messages=%d bytes=%d hash=%s", input.Scope, input.ID, input.Generation, len(snapshot.Messages), len(raw), hash)
				markdown := fmt.Sprintf("# %s\n\nSource: %s\n\n> %s conversation snapshot. Freshness is unknown until rechecked. Alternate branches and attachment files are not backed up.\n", strings.ReplaceAll(title, "\n", " "), url, snapshot.Coverage)
				for _, message := range snapshot.Messages {
					if (message.Role != "user" && message.Role != "assistant") || strings.TrimSpace(message.Text) == "" {
						c.JSON(400, gin.H{"error": "unsupported role or empty message"})
						return
					}
					markdown += fmt.Sprintf("\n## %s\n\n%s\n", message.Role, message.Text)
				}
				// Stable ID paths avoid duplicate searchable transcripts after renames/moves.
				dir := filepath.Join(root, input.Scope, "conversations", input.ID)
				if err = chatGPTDirectory(dir); err != nil {
					fail(err)
					return
				}
				if err = chatGPTWrite(filepath.Join(dir, hash+".json"), raw); err != nil {
					fail(err)
					return
				}
				if err = chatGPTWrite(filepath.Join(dir, "conversation.md"), []byte(markdown)); err != nil {
					fail(err)
					return
				}
				_, err = tx.Exec(`UPDATE chatgpt_conversations SET saved_generation=?,content_hash=?,saved_at=?,error='',lease='',lease_until=0,retry_at=0 WHERE scope=? AND id=?`, input.Generation, hash, now, input.Scope, input.ID)
			}
		default:
			c.JSON(404, gin.H{"error": "unknown backup action"})
			return
		}
		if err != nil {
			fail(err)
			return
		}
		if err = tx.Commit(); err != nil {
			fail(err)
			return
		}
		c.JSON(200, gin.H{"ok": true})
	})
	return nil
}

// Refuse symlinked destination components rather than following page-influenced
// paths outside the backup tree. Only locally generated names reach this helper.
func chatGPTDirectory(dir string) error {
	parent := filepath.Dir(dir)
	if parent != dir {
		if err := chatGPTDirectory(parent); err != nil {
			return err
		}
	}
	info, err := os.Lstat(dir)
	if os.IsNotExist(err) {
		return os.Mkdir(dir, 0700)
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("backup directory is not a real directory: %s", dir)
	}
	return nil
}
func chatGPTWrite(path string, data []byte) error {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("backup destination is not a regular file: %s", path)
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	if existing, err := os.ReadFile(path); err == nil && string(existing) == string(data) {
		return nil
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".backup-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
