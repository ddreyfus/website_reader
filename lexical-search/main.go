package main

import (
	"context"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"lexical-search/config"
	"lexical-search/routes"
	"lexical-search/server"

	"github.com/gin-gonic/gin"
)

func main() {
	// Set log output to stdout
	log.SetOutput(os.Stdout)

	// Initialize server
	router := gin.Default()
	host := "127.0.0.1"
	router.SetTrustedProxies([]string{host})

	si := &routes.Api{}
	options := server.GinServerOptions{
		BaseURL: "/api/v1",
	}
	server.RegisterHandlersWithOptions(router, si, options)
	routes.RegisterRetrievalHandlers(router)

	// Add health check
	router.GET(options.BaseURL+"/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	if _, err := os.Stat(config.ConfigPath); os.IsNotExist(err) {
		if err = config.Save(config.ConfigPath, config.Port, "~/reading-archive", config.IndexDirectories, config.SearchLimit); err != nil {
			log.Fatal(err)
		}
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = strconv.Itoa(config.Port)
	}
	listener, err := net.Listen("tcp", host+":"+port)
	if err != nil {
		log.Fatalf("Failed to listen on port %s: %v", port, err)
	}

	// Print the assigned port and PID
	log.Printf("lexical_search_port: %d", listener.Addr().(*net.TCPAddr).Port)
	log.Printf("lexical_search_pid: %d", os.Getpid())
	registerConfigHandlers(router, config.ConfigPath, listener.Addr().(*net.TCPAddr).Port)

	// Create an http.Server instance to use Shutdown
	srv := &http.Server{Handler: router}

	// Standalone service: shutdown follows OS signals, not stdin EOF.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := config.ValidateIndexDirectories(filepath.Dir(config.LexDir), config.IndexDirectories); err != nil {
		log.Fatal(err)
	}
	indexingDone := make(chan struct{})
	embeddingsDone := make(chan struct{})
	go func() {
		defer close(embeddingsDone)
		routes.WatchEmbeddings(ctx)
	}()
	go func() {
		defer close(indexingDone)
		routes.WatchDirectories(ctx, config.IndexDirectories, 10*time.Second)
	}()
	defer func() { stop(); <-indexingDone; <-embeddingsDone }()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if shutdownErr := srv.Shutdown(shutdownCtx); shutdownErr != nil {
			log.Printf("Error during server shutdown: %v", shutdownErr)
		}
	}()

	// Start server with the existing listener
	if err := srv.Serve(listener); err != http.ErrServerClosed {
		log.Fatalf("The server broke: %v", err)
	}
}

func registerConfigHandlers(router *gin.Engine, path string, activePort int) {
	router.GET("/api/v1/config", func(c *gin.Context) {
		port, root, directories, searchLimit, err := config.Read(path)
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"port": port, "archive_root": root, "index_directories": directories, "search_limit": searchLimit, "active_port": activePort, "active_archive_root": filepath.Dir(config.LexDir), "active_index_directories": config.IndexDirectories})
	})
	router.PUT("/api/v1/config", func(c *gin.Context) {
		// JSON-only writes and extension origins prevent cross-site form submissions.
		origin := c.GetHeader("Origin")
		if origin != "" && !strings.HasPrefix(origin, "chrome-extension://") {
			c.JSON(403, gin.H{"error": "settings writes require an extension or local client"})
			return
		}
		mediaType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
		if err != nil || mediaType != "application/json" {
			c.JSON(415, gin.H{"error": "application/json required"})
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 4096))
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		port, root, directories, searchLimit, err := config.Parse(data)
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		if err = config.Save(path, port, root, directories, searchLimit); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"port": port, "archive_root": root, "index_directories": directories, "search_limit": searchLimit, "restart_required": true})
	})
}

// TODO: need middleware to correctly format error responses when
// automatic parameter validation fails
