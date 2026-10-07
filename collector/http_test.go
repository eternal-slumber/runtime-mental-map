package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalHandlerSeparatesAPIAndSPA(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("mental-map-ui"), 0600); err != nil {
		t.Fatal(err)
	}
	maps, err := openMapStore(filepath.Join(t.TempDir(), "maps.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer maps.db.Close()
	handler := newHandler(&Store{traces: make(map[string]map[string]Event)}, maps, dir)
	for _, test := range []struct {
		path, content string
		status        int
	}{
		{"/health", `"protocol_version":1`, http.StatusOK},
		{"/api/health", `"status":"ok"`, http.StatusOK},
		{"/", "mental-map-ui", http.StatusOK},
		{"/workspace/example", "mental-map-ui", http.StatusOK},
		{"/api/unknown", "404", http.StatusNotFound},
		{"/missing.js", "404", http.StatusNotFound},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", test.path, nil))
		if response.Code != test.status || !strings.Contains(response.Body.String(), test.content) {
			t.Errorf("%s: %d %s", test.path, response.Code, response.Body.String())
		}
	}
}

func TestDataDirectoryAndLegacyDatabasePath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested")
	t.Setenv("MENTAL_MAP_DB", "")
	t.Setenv("MENTAL_MAP_DATA_DIR", dir)
	path, err := databasePath()
	if err != nil || path != filepath.Join(dir, "mental-map.db") {
		t.Fatalf("path=%q error=%v", path, err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MENTAL_MAP_DB", "custom.db")
	path, err = databasePath()
	if err != nil || path != "custom.db" {
		t.Fatalf("legacy override: path=%q error=%v", path, err)
	}
}
