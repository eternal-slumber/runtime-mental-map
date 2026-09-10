package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestMentalMapSurvivesStoreRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "maps.db")
	store, err := openMapStore(path)
	if err != nil {
		t.Fatal(err)
	}

	root := testEvent("request", nil, "GET /api/meals", 1)
	root.Kind = "request"
	mentalMap := MentalMap{
		ServiceName:    "foodtracker",
		Title:          "Meal history",
		SourceTraceIDs: []string{"trace-abc"},
		Viewport:       MapViewport{X: 10, Y: 20, Zoom: 1.5},
		Nodes:          []MapNode{{RuntimeNodeID: "request", X: 30, Y: 40, Collapsed: true, Pinned: true}},
		Notes:          []MapNote{{ID: "note-1", Text: "Check query count", X: 50, Y: 60}},
		Groups:         []MapGroup{{ID: "group-1", Title: "Meal hydration", Width: 300, Height: 200, RuntimeNodeIDs: []string{"request"}}},
		Fields:         []MapField{{Layer: "request", X: 0, Width: 420, ManualMinWidth: 352}},
		ManualEdges:    []MapEdge{{ID: "edge-1", Source: "note-1", Target: "request"}},
		SequenceNames:  map[string]string{"sequence-1": "Meal hydration"},
		Trace:          TraceView{TraceID: "trace-abc", Root: &SpanNode{Event: root, Children: []*SpanNode{}}},
	}
	body, err := json.Marshal(mentalMap)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	store.createMap(response, httptest.NewRequest("POST", "/maps", bytes.NewReader(body)))
	if response.Code != http.StatusCreated {
		t.Fatalf("create failed: %d %s", response.Code, response.Body.String())
	}
	var created MentalMap
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := openMapStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	request := httptest.NewRequest("GET", "/maps/"+created.ID, nil)
	request.SetPathValue("mapID", created.ID)
	response = httptest.NewRecorder()
	reopened.getMap(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("get failed: %d %s", response.Code, response.Body.String())
	}
	var loaded MentalMap
	if err := json.Unmarshal(response.Body.Bytes(), &loaded); err != nil {
		t.Fatal(err)
	}
	if loaded.Title != mentalMap.Title || loaded.Viewport != mentalMap.Viewport || !loaded.Nodes[0].Pinned || loaded.Notes[0].Text != "Check query count" || loaded.Fields[0] != mentalMap.Fields[0] || loaded.SequenceNames["sequence-1"] != "Meal hydration" {
		t.Fatalf("saved workspace was not restored: %#v", loaded)
	}
}
