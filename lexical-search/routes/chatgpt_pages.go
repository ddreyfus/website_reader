package routes

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jmoiron/sqlx"
)

// Empty cursor denotes the first page; SQL NULL next_cursor denotes the end.
func chatGPTPageCursor(tx *sqlx.Tx, scope, id string, generation int64) (string, int, bool, error) {
	cursor := ""
	seen := map[string]bool{}
	for {
		if seen[cursor] {
			return "", len(seen), false, fmt.Errorf("conversation pagination cycle")
		}
		var next sql.NullString
		err := tx.Get(&next, `SELECT next_cursor FROM chatgpt_pages WHERE scope=? AND id=? AND generation=? AND cursor=?`, scope, id, generation, cursor)
		if err == sql.ErrNoRows {
			return cursor, len(seen), false, nil
		}
		if err != nil {
			return "", 0, false, err
		}
		seen[cursor] = true
		if !next.Valid {
			return "", len(seen), true, nil
		}
		cursor = next.String
	}
}

func chatGPTStorePage(tx *sqlx.Tx, scope, id string, generation int64, cursor string, raw json.RawMessage) error {
	if len(cursor) > 2048 {
		return fmt.Errorf("invalid page cursor")
	}
	var page map[string]interface{}
	if json.Unmarshal(raw, &page) != nil {
		return fmt.Errorf("invalid page JSON")
	}
	if remote, ok := page["conversation_id"].(string); ok && remote != id {
		return fmt.Errorf("page conversation mismatch")
	}
	messages, ok := page["messages"].([]interface{})
	if !ok || len(messages) == 0 {
		return fmt.Errorf("page has no supported messages")
	}
	info, ok := page["page_info"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("page has no pagination metadata")
	}
	more, ok := info["has_previous_page"].(bool)
	if !ok {
		return fmt.Errorf("page has no older-page completion flag")
	}
	newer, ok := info["has_next_page"].(bool)
	if !ok || (cursor == "" && newer) {
		return fmt.Errorf("initial page is not a verified latest page")
	}
	if page["context_truncation_continuation"] != nil {
		return fmt.Errorf("context continuation is unsupported; retain partial pages")
	}
	var next interface{}
	if more {
		value, ok := info["start_cursor"].(string)
		if !ok || value == "" || value == cursor || len(value) > 2048 {
			return fmt.Errorf("invalid older-page cursor")
		}
		next = value
	}
	// A saved page is immutable within an observed generation. Never silently
	// replace it after an edit; a fresh inventory observation starts a new generation.
	var existing string
	err := tx.Get(&existing, `SELECT body FROM chatgpt_pages WHERE scope=? AND id=? AND generation=? AND cursor=?`, scope, id, generation, cursor)
	canonical, _ := json.Marshal(page)
	if err == nil {
		if existing != string(canonical) {
			return fmt.Errorf("page changed within generation; rescan inventory")
		}
		return nil
	}
	if err != sql.ErrNoRows {
		return err
	}
	var bytes int64
	if err := tx.Get(&bytes, `SELECT COALESCE(SUM(length(body)),0) FROM chatgpt_pages WHERE scope=? AND id=? AND generation=?`, scope, id, generation); err != nil {
		return err
	}
	if bytes+int64(len(canonical)) > 64<<20 {
		return fmt.Errorf("conversation exceeds 64 MiB page budget; partial pages retained")
	}
	_, err = tx.Exec(`INSERT INTO chatgpt_pages(scope,id,generation,cursor,next_cursor,body) VALUES(?,?,?,?,?,?)`, scope, id, generation, cursor, next, string(canonical))
	return err
}

func chatGPTAssemblePages(tx *sqlx.Tx, scope, id string, generation int64) (json.RawMessage, error) {
	_, count, done, err := chatGPTPageCursor(tx, scope, id, generation)
	if err != nil {
		return nil, err
	}
	if !done {
		return nil, fmt.Errorf("conversation pages are incomplete")
	}
	pages := make([]json.RawMessage, 0, count)
	cursor := ""
	for i := 0; i < count; i++ {
		var raw string
		var next sql.NullString
		if err := tx.QueryRow(`SELECT body,next_cursor FROM chatgpt_pages WHERE scope=? AND id=? AND generation=? AND cursor=?`, scope, id, generation, cursor).Scan(&raw, &next); err != nil {
			return nil, err
		}
		pages = append(pages, json.RawMessage(raw))
		cursor = next.String
	}
	messages := []map[string]interface{}{}
	seen := map[string]string{}
	// Pages arrive newest first; messages within each page retain API order.
	for i := len(pages) - 1; i >= 0; i-- {
		var page map[string]interface{}
		json.Unmarshal(pages[i], &page)
		for _, value := range page["messages"].([]interface{}) {
			message, ok := value.(map[string]interface{})
			if !ok {
				return nil, fmt.Errorf("invalid message")
			}
			key, ok := message["id"].(string)
			if !ok || key == "" {
				return nil, fmt.Errorf("message has no identity")
			}
			canonical, _ := json.Marshal(message)
			if previous, ok := seen[key]; ok {
				if previous != string(canonical) {
					return nil, fmt.Errorf("message changed across pages; rescan inventory")
				}
				continue
			}
			seen[key] = string(canonical)
			status, _ := message["status"].(string)
			if status == "in_progress" || status == "streaming" {
				return nil, fmt.Errorf("conversation is still generating")
			}
			author, _ := message["author"].(map[string]interface{})
			role, _ := author["role"].(string)
			if role != "user" && role != "assistant" {
				continue
			}
			metadata, _ := message["metadata"].(map[string]interface{})
			if metadata["is_visually_hidden_from_conversation"] == true {
				continue
			}
			content, _ := message["content"].(map[string]interface{})
			kind, _ := content["content_type"].(string)
			if kind == "thoughts" || kind == "reasoning_recap" {
				continue
			}
			text, _ := content["text"].(string)
			if parts, ok := content["parts"].([]interface{}); ok {
				var values []string
				for _, part := range parts {
					if s, ok := part.(string); ok {
						values = append(values, s)
					} else {
						values = append(values, "[Non-text content retained in source JSON; attachment file not downloaded.]")
					}
				}
				text = strings.Join(values, "\n")
			}
			if strings.TrimSpace(text) == "" {
				text = "[Content retained in source JSON; readable rendering unavailable.]"
			}
			messages = append(messages, map[string]interface{}{"key": key, "role": role, "text": text})
		}
	}
	if len(messages) == 0 {
		return nil, fmt.Errorf("no readable user or assistant messages")
	}
	return json.Marshal(map[string]interface{}{"id": id, "coverage": "structured", "messages": messages, "pages": pages})
}
