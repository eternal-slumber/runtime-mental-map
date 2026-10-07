package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path"
	"strings"
)

const protocolVersion = 1

func newHandler(store *Store, maps *MapStore, webDir string) http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "protocol_version": protocolVersion})
	})
	api.HandleFunc("POST /events", store.addEvent)
	api.HandleFunc("POST /events/batch", store.addEvents)
	api.HandleFunc("GET /traces", store.getTraces)
	api.HandleFunc("GET /traces/{traceID}", store.getTrace)
	api.HandleFunc("GET /maps", maps.getMaps)
	api.HandleFunc("POST /maps", maps.createMap)
	api.HandleFunc("GET /maps/{mapID}", maps.getMap)
	api.HandleFunc("PUT /maps/{mapID}", maps.updateMap)

	mux := http.NewServeMux()
	mux.Handle("/api/", http.StripPrefix("/api", api))
	// Existing agents and development tooling continue using the original endpoints.
	for _, route := range []string{"/health", "/events", "/events/batch", "/traces", "/traces/", "/maps", "/maps/"} {
		mux.Handle(route, api)
	}
	mux.Handle("/", spaHandler(webDir))
	return mux
}

func spaHandler(webDir string) http.Handler {
	if webDir == "" {
		webDir = "../web/dist"
	}
	files := http.FileServer(http.Dir(webDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := path.Clean("/" + r.URL.Path)
		if name != "/" {
			if info, err := os.Stat(webDir + name); err == nil && !info.IsDir() {
				files.ServeHTTP(w, r)
				return
			}
			if strings.Contains(path.Base(name), ".") {
				http.NotFound(w, r)
				return
			}
		}
		if _, err := os.Stat(webDir + "/index.html"); err != nil {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, webDir+"/index.html")
	})
}
