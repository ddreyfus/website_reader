package routes

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

// Keep the original mapping, including tool messages and non-text references.
// Markdown is a searchable projection; it is never the canonical export.
func chatGPTImport(db *sqlx.DB, root, scope string, raw json.RawMessage, dryRun bool) (string, error) {
	var conversation struct {
		ID             string  `json:"id"`
		ConversationID string  `json:"conversation_id"`
		Title          string  `json:"title"`
		Updated        float64 `json:"update_time"`
		Current        string  `json:"current_node"`
		Mapping        map[string]struct {
			Parent  string          `json:"parent"`
			Message json.RawMessage `json:"message"`
		} `json:"mapping"`
	}
	if err := json.Unmarshal(raw, &conversation); err != nil {
		return "", err
	}
	id := conversation.ID
	if id == "" {
		id = conversation.ConversationID
	}
	if !chatGPTID.MatchString(id) || (conversation.ConversationID != "" && conversation.ConversationID != id) || len(conversation.Title) > 2048 || conversation.Updated <= 0 || math.IsInf(conversation.Updated, 0) {
		return "", fmt.Errorf("invalid export identity, title, or update_time")
	}
	selected := map[string]bool{}
	var path []string
	for node := conversation.Current; node != ""; {
		value, ok := conversation.Mapping[node]
		if !ok || selected[node] {
			return "", fmt.Errorf("missing node or cycle in selected branch")
		}
		selected[node] = true
		path = append(path, node)
		node = value.Parent
	}
	if len(path) == 0 {
		return "", fmt.Errorf("export has no selected branch")
	}
	tx, err := db.Beginx()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	// Serialize with browser claims before touching archive files. A deferred
	// read transaction alone would allow another client to claim this row.
	if !dryRun {
		if _, err := tx.Exec(`UPDATE chatgpt_conversations SET lease_until=lease_until WHERE scope=? AND id=?`, scope, id); err != nil {
			return "", err
		}
	}
	var updated, url, previousHash string
	var leaseUntil, generation, saved int64
	err = tx.QueryRow(`SELECT remote_updated_at,url,content_hash,lease_until,generation,saved_generation FROM chatgpt_conversations WHERE scope=? AND id=?`, scope, id).Scan(&updated, &url, &previousHash, &leaseUntil, &generation, &saved)
	if err != nil && err != sql.ErrNoRows {
		return "", err
	}
	if leaseUntil > time.Now().Unix() {
		return "busy", nil
	}
	if url == "" {
		url = "https://chatgpt.com/c/" + id
	}
	stamp := time.UnixMilli(int64(conversation.Updated * 1000)).UTC()
	newer := false
	if updated != "" {
		previous, err := time.Parse(time.RFC3339Nano, updated)
		if err != nil {
			return "", fmt.Errorf("cannot compare existing remote timestamp: %w", err)
		}
		newer = previous.After(stamp)
	} else if saved > 0 {
		// Unknown browser freshness: preserve its transcript, still retain branches.
		newer = true
	}
	var canonical interface{}
	if err := json.Unmarshal(raw, &canonical); err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(canonical, "", "  ")
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	dir := filepath.Join(root, scope, "conversations", id)
	// A stale export must not replace branches from a more recent export either.
	if previous, err := os.ReadFile(filepath.Join(dir, "export.json")); err == nil {
		var version struct {
			Updated float64 `json:"update_time"`
		}
		if err := json.Unmarshal(previous, &version); err != nil {
			return "", err
		}
		if version.Updated > conversation.Updated {
			return "older-export", nil
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	header := fmt.Sprintf("# %s\n\nSource: %s\n\nExport updated: %s\n", strings.ReplaceAll(conversation.Title, "\n", " "), url, stamp.Format(time.RFC3339Nano))
	var main, branches strings.Builder
	main.WriteString(header)
	branches.WriteString(header + "\nAlternate messages from the exported conversation tree. Parent IDs identify branch relationships; these messages are not one continuous conversation.\n")
	write := func(out *strings.Builder, node string, alternate bool) error {
		var message struct {
			Author struct {
				Role string `json:"role"`
			} `json:"author"`
			Content struct {
				Type  string            `json:"content_type"`
				Parts []json.RawMessage `json:"parts"`
				Text  string            `json:"text"`
			} `json:"content"`
			Metadata struct {
				Hidden bool `json:"is_visually_hidden_from_conversation"`
			} `json:"metadata"`
		}
		if err := json.Unmarshal(conversation.Mapping[node].Message, &message); err != nil && len(conversation.Mapping[node].Message) != 0 {
			return err
		}
		role := message.Author.Role
		if (role != "user" && role != "assistant") || message.Metadata.Hidden || message.Content.Type == "thoughts" || message.Content.Type == "reasoning_recap" {
			return nil
		}
		var parts []string
		for _, raw := range message.Content.Parts {
			var text string
			if json.Unmarshal(raw, &text) == nil {
				parts = append(parts, text)
			}
		}
		text := message.Content.Text
		if len(parts) > 0 {
			text = strings.Join(parts, "\n")
		}
		if strings.TrimSpace(text) == "" {
			return nil
		}
		fmt.Fprintf(out, "\n## %s\n", role)
		if alternate {
			fmt.Fprintf(out, "\nMessage: %s; parent: %s\n", node, conversation.Mapping[node].Parent)
		}
		fmt.Fprintf(out, "\n%s\n", text)
		return nil
	}
	for i := len(path) - 1; i >= 0; i-- {
		if err := write(&main, path[i], false); err != nil {
			return "", err
		}
	}
	keys := make([]string, 0, len(conversation.Mapping))
	for key := range conversation.Mapping {
		if !selected[key] {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := write(&branches, key, true); err != nil {
			return "", err
		}
	}
	result := "imported"
	if newer && saved == 0 {
		result = "pending-refresh"
	} else if newer {
		result = "branches-only"
	} else if previousHash == hash && generation == saved {
		result = "unchanged"
	}
	if dryRun {
		return result, nil
	}
	if err := chatGPTDirectory(dir); err != nil {
		return "", err
	}
	for name, body := range map[string][]byte{"export.json": data, "branches.md": []byte(branches.String())} {
		if err := chatGPTWrite(filepath.Join(dir, name), body); err != nil {
			return "", err
		}
	}
	if !newer || saved == 0 {
		if err := chatGPTWrite(filepath.Join(dir, "conversation.md"), []byte(main.String())); err != nil {
			return "", err
		}
	}
	if newer && saved == 0 {
		// Inventory can be newer without having any downloaded content. Keep its
		// pending generation, but make the exported transcript available meanwhile.
		_, err = tx.Exec(`UPDATE chatgpt_conversations SET content_hash=?,saved_at=? WHERE scope=? AND id=? AND content_hash!=?`, hash, time.Now().Unix(), scope, id, hash)
		if err != nil {
			return "", err
		}
	} else if !newer && result != "unchanged" {
		_, err = tx.Exec(`INSERT INTO chatgpt_conversations(scope,id,title,url,remote_updated_at,generation,saved_generation,content_hash,saved_at) VALUES(?,?,?,?,?,1,1,?,?)
ON CONFLICT(scope,id) DO UPDATE SET title=excluded.title,remote_updated_at=excluded.remote_updated_at,
generation=generation+CASE WHEN content_hash!=excluded.content_hash THEN 1 ELSE 0 END,
saved_generation=generation+CASE WHEN content_hash!=excluded.content_hash THEN 1 ELSE 0 END,
content_hash=excluded.content_hash,saved_at=excluded.saved_at,error='',lease='',lease_until=0,retry_at=0`, scope, id, conversation.Title, url, stamp.Format(time.RFC3339Nano), hash, time.Now().Unix())
		if err != nil {
			return "", err
		}
	}
	return result, tx.Commit()
}
