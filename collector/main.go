package main

import (
	"log"
	"net/http"
	"os"
)

func main() {
	store := &Store{traces: make(map[string]map[string]Event)}
	mapStore, err := openMapStore(databasePath())
	if err != nil {
		log.Fatal(err)
	}
	defer mapStore.db.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("POST /events", store.addEvent)
	mux.HandleFunc("POST /events/batch", store.addEvents)
	mux.HandleFunc("GET /traces", store.getTraces)
	mux.HandleFunc("GET /traces/{traceID}", store.getTrace)
	mux.HandleFunc("GET /maps", mapStore.getMaps)
	mux.HandleFunc("POST /maps", mapStore.createMap)
	mux.HandleFunc("GET /maps/{mapID}", mapStore.getMap)
	mux.HandleFunc("PUT /maps/{mapID}", mapStore.updateMap)
	log.Println("collector listening on http://localhost:9000")
	log.Fatal(http.ListenAndServe(":9000", mux))
}

func databasePath() string {
	if path := os.Getenv("MENTAL_MAP_DB"); path != "" {
		return path
	}
	return "mental-map.db"
}
