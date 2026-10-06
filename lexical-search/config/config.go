package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const WORKSPACE_DB_VERSION = 1
const ARCHIVE_DB_VERSION = 1

const MAX_CHUNK_LENGTH = 4096
const ARCHIVE_BATCH_SIZE = 128
const FILE_CHUNK_LINES = 32

var (
	LexDir           string
	WorkspacesDBPath string
	ConfigPath       string
	Port             int
	IndexDirectories []string
	SearchLimit      int
)

var IgnorePatterns = []string{
	"*.ipynb",
	"*.min.js",
	"*.min.js.map",
	"*.min.css",
	"*.min.css.map",
	"*.tfstate",
	"*.tfstate.backup",
	"*.png",
	"*.jpg",
	"*.jpeg",
	"*.gif",
	"*.bmp",
	"*.tiff",
	"*.ico",
	"*.mp3",
	"*.wav",
	"*.wma",
	"*.ogg",
	"*.flac",
	"*.mp4",
	"*.avi",
	"*.mkv",
	"*.mov",
	"*.wmv",
	"*.m4a",
	"*.m4v",
	"*.3gp",
	"*.3g2",
	"*.rm",
	"*.swf",
	"*.flv",
	"*.iso",
	"*.bin",
	"*.tar",
	"*.zip",
	"*.7z",
	"*.gz",
	"*.rar",
	"*.pdf",
	"*.doc",
	"*.docx",
	"*.xls",
	"*.xlsx",
	"*.ppt",
	"*.pptx",
	"*.svg",
	"*.parquet",
	"*.pyc",
	"*.pub",
	"*.pem",
	"*.so",
	"*.o",
	"*.log",
	"yarn.lock",
	"package-lock.json",
	".git",
}

func init() {
	// This code is automatically executed when the package is imported
	homeDir, err := os.UserHomeDir()
	if err != nil {
		panic(err)
	}

	ConfigPath = os.Getenv("LOCAL_MCP_CONFIG")
	if ConfigPath == "" {
		ConfigPath = filepath.Join(homeDir, ".local-mcp", "config.json")
	}
	var archiveDir string
	Port, archiveDir, IndexDirectories, SearchLimit, err = Read(ConfigPath)
	if err != nil {
		panic(err)
	}
	archiveDir, err = ExpandArchiveRoot(archiveDir)
	if err != nil {
		panic(err)
	}
	if override := os.Getenv("READING_ARCHIVE_DIR"); override != "" {
		archiveDir, err = ExpandArchiveRoot(override)
		if err != nil {
			panic(err)
		}
	}
	LexDir = filepath.Join(archiveDir, "indexes")
	WorkspacesDBPath = filepath.Join(LexDir, "workspaces.sqlite")
}

func ExpandArchiveRoot(root string) (string, error) {
	if strings.HasPrefix(root, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		root = filepath.Join(home, root[2:])
	}
	if !filepath.IsAbs(root) {
		return "", fmt.Errorf("archive_root must be an absolute path or start with ~/")
	}
	return filepath.Clean(root), nil
}

func Read(path string) (int, string, []string, int, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return 8766, "~/reading-archive", []string{}, 30, nil
	}
	if err != nil {
		return 0, "", nil, 0, err
	}
	return Parse(data)
}

func Parse(data []byte) (int, string, []string, int, error) {
	port, root := 8766, "~/reading-archive"
	directories := []string{}
	searchLimit := 30
	var err error
	var values map[string]json.RawMessage
	if err = json.Unmarshal(data, &values); err != nil {
		return 0, "", nil, 0, err
	}
	if values == nil {
		return 0, "", nil, 0, fmt.Errorf("configuration must be a JSON object")
	}
	for key, value := range values {
		switch key {
		case "port":
			if string(value) == "null" {
				return 0, "", nil, 0, fmt.Errorf("port must be an integer")
			}
			err = json.Unmarshal(value, &port)
		case "archive_root":
			if string(value) == "null" {
				return 0, "", nil, 0, fmt.Errorf("archive_root must be a string")
			}
			err = json.Unmarshal(value, &root)
		case "index_directories":
			if string(value) == "null" {
				return 0, "", nil, 0, fmt.Errorf("index_directories must be an array of paths")
			}
			err = json.Unmarshal(value, &directories)
		case "search_limit":
			if string(value) == "null" {
				return 0, "", nil, 0, fmt.Errorf("search_limit must be an integer")
			}
			err = json.Unmarshal(value, &searchLimit)
		default:
			return 0, "", nil, 0, fmt.Errorf("unknown configuration setting: %s", key)
		}
		if err != nil {
			return 0, "", nil, 0, err
		}
	}
	if port < 1 || port > 65535 {
		return 0, "", nil, 0, fmt.Errorf("port must be between 1 and 65535")
	}
	if _, err = ExpandArchiveRoot(root); err != nil {
		return 0, "", nil, 0, err
	}
	if err = ValidateIndexDirectories(root, directories); err != nil {
		return 0, "", nil, 0, err
	}
	if searchLimit < 1 || searchLimit > 100 {
		return 0, "", nil, 0, fmt.Errorf("search_limit must be between 1 and 100")
	}
	return port, root, directories, searchLimit, nil
}

// Save validates before replacing the shared file; active settings change on restart.
func Save(path string, port int, root string, directories []string, searchLimit int) error {
	if searchLimit < 1 || searchLimit > 100 {
		return fmt.Errorf("search_limit must be between 1 and 100")
	}
	if port < 1 || port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535")
	}
	if _, err := ExpandArchiveRoot(root); err != nil {
		return err
	}
	if err := ValidateIndexDirectories(root, directories); err != nil {
		return err
	}
	if directories == nil {
		directories = []string{}
	}
	data, err := json.MarshalIndent(map[string]interface{}{"port": port, "archive_root": root, "index_directories": directories, "search_limit": searchLimit}, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".config-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(append(data, '\n')); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

// Keep index output outside source trees to avoid recursively indexing our own state.
func ValidateIndexDirectories(root string, directories []string) error {
	root, err := ExpandArchiveRoot(root)
	if err != nil {
		return err
	}
	indexPath := filepath.Join(root, "indexes")
	if resolved, err := filepath.EvalSymlinks(indexPath); err == nil {
		indexPath = resolved
	}
	seen := []string{}
	for _, directory := range directories {
		directory, err = ExpandArchiveRoot(directory)
		if err != nil {
			return fmt.Errorf("index_directories: %w", err)
		}
		if resolved, err := filepath.EvalSymlinks(directory); err == nil {
			directory = resolved
		}
		if ContainsPath(directory, indexPath) || ContainsPath(indexPath, directory) {
			return fmt.Errorf("indexed directories must not overlap the index storage directory")
		}
		for _, previous := range seen {
			if ContainsPath(previous, directory) || ContainsPath(directory, previous) {
				return fmt.Errorf("indexed directories must not overlap each other")
			}
		}
		seen = append(seen, directory)
	}
	return nil
}

func ContainsPath(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
