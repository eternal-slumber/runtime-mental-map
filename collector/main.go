package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func main() {
	store := &Store{traces: make(map[string]map[string]Event)}
	path, err := databasePath()
	if err != nil {
		log.Fatal(err)
	}
	mapStore, err := openMapStore(path)
	if err != nil {
		log.Fatal(err)
	}
	defer mapStore.db.Close()

	server := &http.Server{Addr: ":9000", Handler: newHandler(store, mapStore, os.Getenv("MENTAL_MAP_WEB_DIR"))}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()
	log.Println("Runtime Mental Map: http://localhost:9000")
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func databasePath() (string, error) {
	if path := os.Getenv("MENTAL_MAP_DB"); path != "" {
		return path, nil
	}
	if dir := os.Getenv("MENTAL_MAP_DATA_DIR"); dir != "" {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return "", err
		}
		return filepath.Join(dir, "mental-map.db"), nil
	}
	return "mental-map.db", nil
}
