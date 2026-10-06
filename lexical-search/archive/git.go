package archive

import (
	"context"
	"crypto/sha1"
	"fmt"
	"io"
	"io/fs"
	"lexical-search/config"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/go-git/go-billy/v5/osfs"
	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/cache"
	"github.com/go-git/go-git/v5/plumbing/format/gitignore"
	"github.com/go-git/go-git/v5/storage/filesystem"
)

func AddIgnorePatterns(wt *git.Worktree) *git.Worktree {
	for _, pattern := range config.IgnorePatterns {
		wt.Excludes = append(wt.Excludes, gitignore.ParsePattern(pattern, nil))
	}
	return wt
}

func AggregateGitignorePatterns(currentPath string) ([]string, error) {
	var patterns []string

	for {
		parentPath := filepath.Dir(currentPath)
		if parentPath == currentPath {
			// Reached the filesystem root
			break
		}
		currentPath = parentPath

		gitignorePath := filepath.Join(currentPath, ".gitignore")
		if _, err := os.Stat(gitignorePath); err == nil {
			// .gitignore exists, read and parse it
			content, err := os.ReadFile(gitignorePath)
			if err != nil {
				continue
			}
			lines := strings.Split(string(content), "\n")
			for _, line := range lines {
				trimmed := strings.TrimSpace(line)
				if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
					patterns = append(patterns, trimmed)
				}
			}
		}

	}

	// reverse patterns
	n := len(patterns)
	revPatterns := make([]string, n)
	for i, pattern := range patterns {
		revPatterns[n-1-i] = pattern
	}

	return revPatterns, nil
}

func InitRepo(gitDir string, workTree string) (*git.Repository, error) {
	// Create the gitDir if it doesn't exist
	err := os.MkdirAll(gitDir, 0755)
	if err != nil {
		return nil, err
	}

	// Initialize a new repository in the gitDir
	repo, err := git.PlainInit(gitDir, false)
	if err != nil {
		return nil, err
	}

	// Set the workTree
	cfg, err := repo.Config()
	if err != nil {
		return nil, err
	}
	cfg.Core.Worktree = workTree

	// Set the author
	cfg.User.Name = "Website Reader"
	cfg.User.Email = "website-reader@localhost"

	// Save the config
	err = repo.Storer.SetConfig(cfg)
	if err != nil {
		return nil, err
	}

	// Aggregate .gitignore patterns from workTree upwards
	aggregatedPatterns, err := AggregateGitignorePatterns(workTree)
	if err != nil {
		log.Printf("Error aggregating .gitignore patterns: %v", err)
		// Decide how to handle the error; you might continue without the aggregated patterns or return the error
	}

	// Set the .git/info/exclude patterns with config.IgnorePatterns and aggregatedPatterns
	infoPath := filepath.Join(gitDir, ".git", "info")
	err = os.MkdirAll(infoPath, 0755)
	if err != nil {
		return nil, err
	}

	excludeFilePath := filepath.Join(infoPath, "exclude")
	excludeFile, err := os.OpenFile(excludeFilePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return nil, err
	}
	defer excludeFile.Close()

	// Write both config.IgnorePatterns and aggregatedPatterns to excludeFile
	for _, pattern := range append(config.IgnorePatterns, aggregatedPatterns...) {
		_, err = excludeFile.WriteString(pattern + "\n")
		if err != nil {
			return nil, err
		}
	}

	return repo, nil
}

func OpenRepo(gitDir string, workTree string) (*git.Repository, error) {
	// Create a filesystem for the .git directory
	gitFs := osfs.New(filepath.Join(gitDir, ".git"))

	// Create a filesystem for the worktree
	workTreeFs := osfs.New(workTree)

	// Open the Git storage
	storer := filesystem.NewStorage(gitFs, cache.NewObjectLRUDefault())

	// Open the repository with the specified storage and worktree filesystem
	repo, err := git.Open(storer, workTreeFs)
	if err != nil {
		return nil, err
	}

	return repo, nil
}

func ListCommitHashes(ctx context.Context, gitDir string, workTree string, sinceHash string) ([]string, error) {

	logCmd := []string{"--git-dir=" + gitDir, "--work-tree=" + workTree, "log", "--format=%H"}
	if sinceHash != "" {
		logCmd = append(logCmd, sinceHash+"..HEAD")
	}

	cmd := exec.CommandContext(ctx, "git", logCmd...)
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	if len(output) == 0 {
		return []string{}, nil
	}

	commitHashes := strings.Split(strings.TrimSpace(string(output)), "\n")
	return commitHashes, nil
}

func ListHashFiles(ctx context.Context, gitDir string, workTree string, commitHash string) ([]string, error) {
	// NUL delimiters preserve spaces, Unicode, tabs, and newlines in filenames.
	showCmd := []string{"--git-dir=" + gitDir, "--work-tree=" + workTree, "show", "--name-status", "--format=", "-z", commitHash}
	output, err := exec.CommandContext(ctx, "git", showCmd...).Output()
	if err != nil {
		return nil, err
	}
	fields := strings.Split(string(output), "\x00")
	files := []string{}
	for i := 0; i < len(fields) && fields[i] != ""; {
		status := fields[i]
		i++
		count := 1
		if strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C") {
			count = 2
		}
		for n := 0; n < count && i < len(fields); n++ {
			if fields[i] != "" {
				files = append(files, fields[i])
			}
			i++
		}
	}

	return files, nil
}

func union(a, b []string) []string {
	// Using a map to ensure uniqueness
	unionSet := make(map[string]struct{})

	// Add all elements from the first array to the map
	for _, item := range a {
		unionSet[item] = struct{}{}
	}

	// Add all elements from the second array to the map
	for _, item := range b {
		unionSet[item] = struct{}{}
	}

	// Convert the map keys back to a slice
	var unionSlice []string
	for item := range unionSet {
		unionSlice = append(unionSlice, item)
	}

	return unionSlice
}

func CheckpointLatest(ctx context.Context, gitDir string, workTree string, lastIndexedCommit string) (string, []string, error) {
	log.Println("CheckpointLatest")
	log.Println("gitDir:", gitDir)
	log.Println("workTree:", workTree)
	log.Println("lastIndexedCommit:", lastIndexedCommit)

	dotGit := filepath.Join(gitDir, ".git")

	// Stage text directly, including files inside nested Git repositories.
	if err := stageTextFiles(ctx, dotGit, workTree); err != nil {
		return "", nil, err
	}

	// Commit the changes
	commitCmd := []string{"--git-dir=" + dotGit, "--work-tree=" + workTree, "commit", "-m", "Checkpoint Latest"}
	cmd := exec.CommandContext(ctx, "git", commitCmd...)
	out, err := cmd.CombinedOutput()
	out_str := string(out)
	log.Printf("Checkpoint commit: %v", err)
	ignorable := strings.Contains(out_str, "nothing to commit") ||
		strings.Contains(out_str, "nothing added to commit") ||
		strings.Contains(out_str, "no changes added to commit")
	if err != nil && !ignorable {
		return "", nil, err
	}

	// An empty new source has no HEAD yet; it is still a valid empty index.
	if lastIndexedCommit == "" && ignorable {
		check := exec.CommandContext(ctx, "git", "--git-dir="+dotGit, "rev-parse", "--verify", "HEAD")
		if err := check.Run(); err != nil {
			return "", []string{}, nil
		}
	}

	// Get the latest commit hash
	commitHashes, err := ListCommitHashes(ctx, dotGit, workTree, lastIndexedCommit)
	if err != nil {
		return "", nil, err
	}
	latestHash := lastIndexedCommit
	if len(commitHashes) > 0 {
		latestHash = commitHashes[0]
	}
	log.Println("latestHash:", latestHash)

	// Get the files changed in all commit hashes
	filesAcc := []string{}
	for _, commitHash := range commitHashes {
		files, err := ListHashFiles(ctx, dotGit, workTree, commitHash)
		if err != nil {
			return "", nil, err
		}
		filesAcc = union(filesAcc, files)
	}
	log.Printf("need to update %d files", len(filesAcc))

	return latestHash, filesAcc, nil
}

func stageTextFiles(ctx context.Context, gitDir, workTree string) error {
	output, err := exec.CommandContext(ctx, "git", "--git-dir="+gitDir, "ls-files", "--stage", "-z").Output()
	if err != nil {
		return err
	}
	tracked := map[string]string{}
	for _, record := range strings.Split(string(output), "\x00") {
		parts := strings.SplitN(record, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		fields := strings.Fields(parts[0])
		if len(fields) == 3 {
			tracked[parts[1]] = fields[1]
		}
	}
	seen := map[string]bool{}
	// Remove legacy non-text entries and Git links before adding their text children.
	for path := range tracked {
		if !SupportedFile(path) {
			if err := exec.CommandContext(ctx, "git", "--git-dir="+gitDir, "update-index", "--force-remove", "--", path).Run(); err != nil {
				return fmt.Errorf("remove legacy entry %s: %w", path, err)
			}
			delete(tracked, path)
		}
	}
	err = filepath.WalkDir(workTree, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !SupportedFile(path) || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		relative, err := filepath.Rel(workTree, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		seen[relative] = true
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		hash := sha1.New()
		fmt.Fprintf(hash, "blob %d\x00", info.Size())
		_, err = io.Copy(hash, file)
		file.Close()
		if err != nil {
			return err
		}
		if tracked[relative] == fmt.Sprintf("%x", hash.Sum(nil)) {
			return nil
		}
		blob, err := exec.CommandContext(ctx, "git", "--git-dir="+gitDir, "hash-object", "-w", "--", path).Output()
		if err != nil {
			return err
		}
		output, err := exec.CommandContext(ctx, "git", "--git-dir="+gitDir, "update-index", "--add", "--cacheinfo", "100644,"+strings.TrimSpace(string(blob))+","+relative).CombinedOutput()
		if err != nil {
			return fmt.Errorf("stage %s: %w: %s", relative, err, strings.TrimSpace(string(output)))
		}
		return nil
	})
	if err != nil {
		return err
	}
	for path := range tracked {
		if !seen[path] {
			if err := exec.CommandContext(ctx, "git", "--git-dir="+gitDir, "update-index", "--force-remove", "--", path).Run(); err != nil {
				return err
			}
		}
	}
	return nil
}

// TODO: if we detect a change in a .gitignore or in config.IgnorePatterns
// we need special handling to potentially drop files from git's index, etc.

// TODO: break apart CheckpointLatest. when updating the archive we may want
// to wait to commit until we have updated the bleve index, etc.
