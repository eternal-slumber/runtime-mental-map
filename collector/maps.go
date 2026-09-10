package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type MapViewport struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Zoom float64 `json:"zoom"`
}

type MapNode struct {
	RuntimeNodeID string  `json:"runtime_node_id"`
	X             float64 `json:"x"`
	Y             float64 `json:"y"`
	Hidden        bool    `json:"hidden"`
	Collapsed     bool    `json:"collapsed"`
	Pinned        bool    `json:"pinned"`
}

type MapNote struct {
	ID     string  `json:"id"`
	Text   string  `json:"text"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Pinned bool    `json:"pinned"`
}

type MapGroup struct {
	ID             string   `json:"id"`
	Title          string   `json:"title"`
	X              float64  `json:"x"`
	Y              float64  `json:"y"`
	Width          float64  `json:"width"`
	Height         float64  `json:"height"`
	RuntimeNodeIDs []string `json:"runtime_node_ids"`
}

type MapField struct {
	Layer          string  `json:"layer"`
	X              float64 `json:"x"`
	Width          float64 `json:"width"`
	ManualMinWidth float64 `json:"manual_min_width"`
}

type MapEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
}

type MentalMap struct {
	ID             string            `json:"id"`
	ServiceName    string            `json:"service_name"`
	Title          string            `json:"title"`
	SourceTraceIDs []string          `json:"source_trace_ids"`
	Viewport       MapViewport       `json:"viewport"`
	Nodes          []MapNode         `json:"nodes"`
	Notes          []MapNote         `json:"notes"`
	Groups         []MapGroup        `json:"groups"`
	Fields         []MapField        `json:"fields,omitempty"`
	ManualEdges    []MapEdge         `json:"manual_edges"`
	SequenceNames  map[string]string `json:"sequence_names"`
	Trace          TraceView         `json:"trace"`
	CreatedAt      time.Time         `json:"created_at"`
}

type MentalMapSummary struct {
	ID          string    `json:"id"`
	ServiceName string    `json:"service_name"`
	Title       string    `json:"title"`
	CreatedAt   time.Time `json:"created_at"`
}

type MapStore struct {
	db *sql.DB
}

func openMapStore(path string) (*MapStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS mental_maps (
		id TEXT PRIMARY KEY,
		service_name TEXT NOT NULL,
		title TEXT NOT NULL,
		created_at TEXT NOT NULL,
		payload BLOB NOT NULL
	)`); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &MapStore{db: db}, nil
}

func (s *MapStore) createMap(w http.ResponseWriter, r *http.Request) {
	var mentalMap MentalMap
	if err := decodeMap(w, r, &mentalMap); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := validateMap(mentalMap); err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}

	id, err := randomID()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	mentalMap.ID = id
	mentalMap.CreatedAt = time.Now().UTC()
	if err := s.insert(mentalMap); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, mentalMap)
}

func (s *MapStore) updateMap(w http.ResponseWriter, r *http.Request) {
	mentalMap, err := s.find(r.PathValue("mapID"))
	if errors.Is(err, sql.ErrNoRows) {
		http.Error(w, "map not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var replacement MentalMap
	if err := decodeMap(w, r, &replacement); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	replacement.ID = mentalMap.ID
	replacement.CreatedAt = mentalMap.CreatedAt
	if err := validateMap(replacement); err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	if err := s.replace(replacement); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, replacement)
}

func (s *MapStore) getMaps(w http.ResponseWriter, _ *http.Request) {
	rows, err := s.db.Query(`SELECT id, service_name, title, created_at FROM mental_maps ORDER BY created_at DESC`)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	maps := []MentalMapSummary{}
	for rows.Next() {
		var item MentalMapSummary
		var createdAt string
		if err := rows.Scan(&item.ID, &item.ServiceName, &item.Title, &createdAt); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		item.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
		maps = append(maps, item)
	}
	writeJSON(w, maps)
}

func (s *MapStore) getMap(w http.ResponseWriter, r *http.Request) {
	mentalMap, err := s.find(r.PathValue("mapID"))
	if errors.Is(err, sql.ErrNoRows) {
		http.Error(w, "map not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, mentalMap)
}

func decodeMap(w http.ResponseWriter, r *http.Request, mentalMap *MentalMap) error {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(mentalMap); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	return ensureJSONEnded(decoder)
}

func validateMap(mentalMap MentalMap) error {
	if strings.TrimSpace(mentalMap.Title) == "" {
		return errors.New("title is required")
	}
	if mentalMap.ServiceName == "" {
		return errors.New("service_name is required")
	}
	if len(mentalMap.SourceTraceIDs) == 0 || mentalMap.Trace.TraceID == "" {
		return errors.New("source trace is required")
	}
	foundSource := false
	for _, traceID := range mentalMap.SourceTraceIDs {
		foundSource = foundSource || traceID == mentalMap.Trace.TraceID
	}
	if !foundSource {
		return errors.New("trace snapshot must match source_trace_ids")
	}
	seen := make(map[string]bool, len(mentalMap.Nodes))
	runtimeNodes := make(map[string]bool, len(mentalMap.Nodes))
	for _, node := range mentalMap.Nodes {
		if node.RuntimeNodeID == "" {
			return errors.New("runtime_node_id is required")
		}
		if seen[node.RuntimeNodeID] {
			return fmt.Errorf("duplicate runtime_node_id %q", node.RuntimeNodeID)
		}
		seen[node.RuntimeNodeID] = true
		runtimeNodes[node.RuntimeNodeID] = true
	}
	for _, note := range mentalMap.Notes {
		if note.ID == "" || strings.TrimSpace(note.Text) == "" {
			return errors.New("note id and text are required")
		}
		if seen[note.ID] {
			return fmt.Errorf("duplicate map object id %q", note.ID)
		}
		seen[note.ID] = true
	}
	for _, group := range mentalMap.Groups {
		if group.ID == "" || strings.TrimSpace(group.Title) == "" {
			return errors.New("group id and title are required")
		}
		if group.Width <= 0 || group.Height <= 0 {
			return errors.New("group dimensions must be positive")
		}
		if seen[group.ID] {
			return fmt.Errorf("duplicate map object id %q", group.ID)
		}
		for _, runtimeNodeID := range group.RuntimeNodeIDs {
			if !runtimeNodes[runtimeNodeID] {
				return fmt.Errorf("group references unknown runtime node %q", runtimeNodeID)
			}
		}
		seen[group.ID] = true
	}
	fieldLayers := make(map[string]bool, len(mentalMap.Fields))
	for _, field := range mentalMap.Fields {
		if strings.TrimSpace(field.Layer) == "" || field.Width <= 0 || field.ManualMinWidth <= 0 {
			return errors.New("field layer and positive widths are required")
		}
		if fieldLayers[field.Layer] {
			return fmt.Errorf("duplicate field layer %q", field.Layer)
		}
		fieldLayers[field.Layer] = true
	}
	edgeIDs := make(map[string]bool, len(mentalMap.ManualEdges))
	for _, edge := range mentalMap.ManualEdges {
		if edge.ID == "" || !seen[edge.Source] || !seen[edge.Target] {
			return errors.New("manual edge must reference existing map objects")
		}
		if edgeIDs[edge.ID] {
			return fmt.Errorf("duplicate manual edge id %q", edge.ID)
		}
		edgeIDs[edge.ID] = true
	}
	return nil
}

func (s *MapStore) insert(mentalMap MentalMap) error {
	payload, err := json.Marshal(mentalMap)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`INSERT INTO mental_maps (id, service_name, title, created_at, payload) VALUES (?, ?, ?, ?, ?)`,
		mentalMap.ID,
		mentalMap.ServiceName,
		mentalMap.Title,
		mentalMap.CreatedAt.Format(time.RFC3339Nano),
		payload,
	)
	return err
}

func (s *MapStore) replace(mentalMap MentalMap) error {
	payload, err := json.Marshal(mentalMap)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`UPDATE mental_maps SET service_name = ?, title = ?, payload = ? WHERE id = ?`,
		mentalMap.ServiceName,
		mentalMap.Title,
		payload,
		mentalMap.ID,
	)
	return err
}

func (s *MapStore) find(id string) (MentalMap, error) {
	var payload []byte
	err := s.db.QueryRow(`SELECT payload FROM mental_maps WHERE id = ?`, id).Scan(&payload)
	if err != nil {
		return MentalMap{}, err
	}
	var mentalMap MentalMap
	err = json.Unmarshal(payload, &mentalMap)
	return mentalMap, err
}

func randomID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}
