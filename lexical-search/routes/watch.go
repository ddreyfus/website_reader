package routes

import (
	"context"
	"io/fs"
	"lexical-search/archive"
	"lexical-search/config"
	"lexical-search/sse"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// WatchDirectories performs one reconciliation at a time. The timer also repairs
// missed events, unavailable roots that reappear, and new directory watches.
func WatchDirectories(ctx context.Context, directories []string, interval time.Duration) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("Filesystem notifications unavailable: %v; polling continues", err)
	}
	watchDirectories(ctx, directories, interval, watcher)
}

// A nil watcher runs the same reconciliation loop using only the timer.
func watchDirectories(ctx context.Context, directories []string, interval time.Duration, watcher *fsnotify.Watcher) {
	changed := make(chan struct{}, 1)
	if watcher != nil {
		defer watcher.Close()
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case _, ok := <-watcher.Events:
					if !ok {
						return
					}
					select {
					case changed <- struct{}{}:
					default:
					}
				case err, ok := <-watcher.Errors:
					if !ok {
						return
					}
					log.Printf("Filesystem notification error: %v", err)
					select {
					case changed <- struct{}{}:
					default:
					}
				}
			}
		}()
	}
	reconcile := func() {
		if watcher != nil {
			refreshWatches(watcher, directories)
		}
		reconcileDirectories(ctx, directories)
	}
	reconcile()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	// Coalesce bursts, including a file being written in several steps.
	debounce := time.NewTimer(time.Hour)
	debounce.Stop()
	defer debounce.Stop()
	var pending <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reconcile()
		case <-changed:
			if !debounce.Stop() {
				select {
				case <-debounce.C:
				default:
				}
			}
			debounce.Reset(250 * time.Millisecond)
			pending = debounce.C
		case <-pending:
			pending = nil
			reconcile()
		}
	}
}

func refreshWatches(watcher *fsnotify.Watcher, directories []string) {
	existing := map[string]bool{}
	for _, path := range watcher.WatchList() {
		existing[path] = true
	}
	desired := map[string]bool{}
	for _, directory := range directories {
		root, err := config.ExpandArchiveRoot(directory)
		if err != nil {
			log.Print(err)
			continue
		}
		if resolved, err := filepath.EvalSymlinks(root); err == nil {
			root = resolved
		}
		err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !entry.IsDir() {
				return nil
			}
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			desired[path] = true
			if !existing[path] {
				if err := watcher.Add(path); err != nil {
					log.Printf("Cannot watch %s: %v; polling continues", path, err)
				}
			}
			return nil
		})
		if err != nil {
			log.Printf("Cannot walk watched directory %s: %v", root, err)
		}
	}
	for path := range existing {
		if !desired[path] {
			watcher.Remove(path)
		}
	}
}

func reconcileDirectories(ctx context.Context, directories []string) {
	for _, directory := range directories {
		if ctx.Err() != nil {
			return
		}
		root, err := config.ExpandArchiveRoot(directory)
		if err != nil {
			log.Print(err)
			continue
		}
		// A disconnected volume is not evidence that all its documents were deleted.
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			log.Printf("Indexed directory unavailable: %s", root)
			continue
		}
		if resolved, err := filepath.EvalSymlinks(root); err == nil {
			root = resolved
		}
		workspace, err := ensureWorkspaceExists("", root)
		if err != nil {
			log.Printf("Cannot prepare index for %s: %v", root, err)
			continue
		}
		events := make(chan sse.Event)
		errors := make(chan error)
		done := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			archive.ArchiveUpdateEventGenerator(ctx, workspace, events, errors, &wg)
			close(done)
		}()
		for {
			select {
			case <-events:
			case err := <-errors:
				log.Printf("Cannot update index for %s: %v", root, err)
			case <-done:
				goto nextDirectory
			}
		}
	nextDirectory:
	}
}
