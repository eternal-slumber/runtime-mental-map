package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
)

type Event struct {
	TraceID         string  `json:"trace_id"`
	SpanID          string  `json:"span_id"`
	ParentID        *string `json:"parent_id"`
	Kind            string  `json:"kind"`
	Runtime         string  `json:"runtime"`
	Framework       string  `json:"framework"`
	Layer           *string `json:"layer"`
	Name            string  `json:"name"`
	Class           *string `json:"class"`
	Method          *string `json:"method"`
	StartedAtUnixUS int64   `json:"started_at_unix_us"`
	DurationNS      int64   `json:"duration_ns"`
}

type SpanNode struct {
	Event
	Children []*SpanNode `json:"children"`
}

type TraceView struct {
	TraceID        string      `json:"trace_id"`
	Status         string      `json:"status"`
	SpanCount      int         `json:"span_count"`
	Root           *SpanNode   `json:"root"`
	Orphans        []*SpanNode `json:"orphans"`
	MissingParents []string    `json:"missing_parents"`
	Errors         []string    `json:"errors"`
}

type TraceSummary struct {
	TraceID    string `json:"trace_id"`
	Status     string `json:"status"`
	Name       string `json:"name"`
	DurationNS int64  `json:"duration_ns"`
	SpanCount  int    `json:"span_count"`
}

type Store struct {
	mu     sync.RWMutex
	traces map[string]map[string]Event
}

func main() {
	store := &Store{traces: make(map[string]map[string]Event)}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /events", store.addEvent)
	mux.HandleFunc("GET /traces", store.getTraces)
	mux.HandleFunc("GET /traces/{traceID}", store.getTrace)
	log.Println("collector listening on http://localhost:9000")
	log.Fatal(http.ListenAndServe(":9000", mux))
}

func (s *Store) addEvent(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var event Event
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&event); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := ensureJSONEnded(decoder); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := validate(event); err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	if err := s.save(event); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *Store) save(event Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	trace := s.traces[event.TraceID]
	if trace == nil {
		trace = make(map[string]Event)
		s.traces[event.TraceID] = trace
	}
	if existing, ok := trace[event.SpanID]; ok {
		if reflect.DeepEqual(existing, event) {
			return nil // Повтор доставки одного события безопасен.
		}
		return fmt.Errorf("span_id %q already exists with different data", event.SpanID)
	}
	if event.ParentID == nil {
		for _, existing := range trace {
			if existing.ParentID == nil {
				return fmt.Errorf("trace already has root span %q", existing.SpanID)
			}
		}
	}
	if createsCycle(trace, event) {
		return fmt.Errorf("span %q creates a parent cycle", event.SpanID)
	}
	trace[event.SpanID] = event
	return nil
}

func createsCycle(trace map[string]Event, event Event) bool {
	parentID := event.ParentID
	seen := make(map[string]bool)
	for parentID != nil {
		if *parentID == event.SpanID || seen[*parentID] {
			return true
		}
		seen[*parentID] = true
		parent, ok := trace[*parentID]
		if !ok {
			return false
		}
		parentID = parent.ParentID
	}
	return false
}

func (s *Store) getTraces(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	traces := make(map[string][]Event, len(s.traces))
	for traceID, stored := range s.traces {
		for _, event := range stored {
			traces[traceID] = append(traces[traceID], event)
		}
	}
	s.mu.RUnlock()

	summaries := make([]TraceSummary, 0, len(traces))
	for traceID, events := range traces {
		view := buildTrace(traceID, events)
		summary := TraceSummary{TraceID: traceID, Status: view.Status, SpanCount: len(events)}
		if view.Root != nil {
			summary.Name = view.Root.Name
			summary.DurationNS = view.Root.DurationNS
		}
		summaries = append(summaries, summary)
	}
	sort.Slice(summaries, func(i, j int) bool { return summaries[i].TraceID < summaries[j].TraceID })

	if wantsText(r) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		for _, summary := range summaries {
			name := summary.Name
			if name == "" {
				name = "[waiting for root]"
			}
			fmt.Fprintf(w, "%s  [%s]  %s  %s  %d spans\n", summary.TraceID, summary.Status,
				name, time.Duration(summary.DurationNS), summary.SpanCount)
		}
		return
	}
	writeJSON(w, summaries)
}

func (s *Store) getTrace(w http.ResponseWriter, r *http.Request) {
	traceID := r.PathValue("traceID")
	s.mu.RLock()
	stored := s.traces[traceID]
	events := make([]Event, 0, len(stored))
	for _, event := range stored {
		events = append(events, event)
	}
	s.mu.RUnlock()
	if len(events) == 0 {
		http.Error(w, "trace not found", http.StatusNotFound)
		return
	}

	view := buildTrace(traceID, events)
	if wantsText(r) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, renderText(view))
		return
	}
	writeJSON(w, view)
}

func validate(event Event) error {
	if event.TraceID == "" {
		return errors.New("trace_id is required")
	}
	if event.SpanID == "" {
		return errors.New("span_id is required")
	}
	if event.Name == "" {
		return errors.New("name is required")
	}
	if event.Runtime == "" {
		return errors.New("runtime is required")
	}
	if event.Framework == "" {
		return errors.New("framework is required")
	}
	if event.ParentID != nil && *event.ParentID == event.SpanID {
		return errors.New("span cannot be its own parent")
	}
	switch event.Kind {
	case "request", "method", "sql":
	default:
		return errors.New("kind must be request, method or sql")
	}
	if event.StartedAtUnixUS < 0 {
		return errors.New("started_at_unix_us cannot be negative")
	}
	if event.DurationNS < 0 {
		return errors.New("duration_ns cannot be negative")
	}
	return nil
}

func ensureJSONEnded(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("request body must contain one JSON object")
	}
	return nil
}

func buildTrace(traceID string, events []Event) TraceView {
	view := TraceView{TraceID: traceID, Status: "incomplete", SpanCount: len(events),
		Orphans: []*SpanNode{}, MissingParents: []string{}, Errors: []string{}}
	nodes := make(map[string]*SpanNode, len(events))
	byID := make(map[string]Event, len(events))
	for _, event := range events {
		nodes[event.SpanID] = &SpanNode{Event: event, Children: []*SpanNode{}}
		byID[event.SpanID] = event
	}
	if hasCycle(byID) {
		view.Status = "invalid"
		view.Errors = append(view.Errors, "trace contains a parent cycle")
		return view
	}

	var roots []*SpanNode
	missing := make(map[string]bool)
	for _, current := range nodes {
		if current.ParentID == nil {
			roots = append(roots, current)
			continue
		}
		if parent := nodes[*current.ParentID]; parent != nil {
			parent.Children = append(parent.Children, current)
		} else {
			view.Orphans = append(view.Orphans, current)
			missing[*current.ParentID] = true
		}
	}
	for parentID := range missing {
		view.MissingParents = append(view.MissingParents, parentID)
	}
	sort.Strings(view.MissingParents)
	sortNodes(roots)
	sortNodes(view.Orphans)
	if len(roots) > 0 {
		view.Root = roots[0]
	}
	if len(roots) > 1 {
		view.Status = "invalid"
		view.Errors = append(view.Errors, "trace contains multiple root spans")
		view.Orphans = append(view.Orphans, roots[1:]...)
	} else if len(roots) == 1 && len(view.Orphans) == 0 {
		view.Status = "complete"
	}
	return view
}

func hasCycle(events map[string]Event) bool {
	state := make(map[string]uint8, len(events))
	var visit func(string) bool
	visit = func(spanID string) bool {
		if state[spanID] == 1 {
			return true
		}
		if state[spanID] == 2 {
			return false
		}
		state[spanID] = 1
		event := events[spanID]
		if event.ParentID != nil {
			if _, ok := events[*event.ParentID]; ok && visit(*event.ParentID) {
				return true
			}
		}
		state[spanID] = 2
		return false
	}
	for spanID := range events {
		if visit(spanID) {
			return true
		}
	}
	return false
}

func sortNodes(nodes []*SpanNode) {
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].StartedAtUnixUS == nodes[j].StartedAtUnixUS {
			return nodes[i].SpanID < nodes[j].SpanID
		}
		return nodes[i].StartedAtUnixUS < nodes[j].StartedAtUnixUS
	})
	for _, current := range nodes {
		sortNodes(current.Children)
	}
}

func renderText(view TraceView) string {
	var output strings.Builder
	fmt.Fprintf(&output, "Trace %s [%s]\n", view.TraceID, view.Status)
	if view.Root != nil {
		writeNode(&output, view.Root, "", "")
	}
	if len(view.Orphans) > 0 {
		output.WriteString("orphan spans:\n")
		for i, orphan := range view.Orphans {
			connector := "├── "
			if i == len(view.Orphans)-1 {
				connector = "└── "
			}
			writeNode(&output, orphan, "", connector)
		}
	}
	if len(view.MissingParents) > 0 {
		output.WriteString("missing parents:\n")
		for i, parentID := range view.MissingParents {
			connector := "├── "
			if i == len(view.MissingParents)-1 {
				connector = "└── "
			}
			fmt.Fprintf(&output, "%s%s\n", connector, parentID)
		}
	}
	for _, message := range view.Errors {
		fmt.Fprintf(&output, "error: %s\n", message)
	}
	return output.String()
}

func writeNode(output *strings.Builder, current *SpanNode, prefix, connector string) {
	fmt.Fprintf(output, "%s%s%s\n", prefix, connector, label(current.Event))
	for i, child := range current.Children {
		childPrefix := prefix
		if connector == "└── " {
			childPrefix += "    "
		} else if connector != "" {
			childPrefix += "│   "
		}
		childConnector := "├── "
		if i == len(current.Children)-1 {
			childConnector = "└── "
		}
		writeNode(output, child, childPrefix, childConnector)
	}
}

func label(event Event) string {
	if event.Kind == "request" {
		return "HTTP " + event.Name
	}
	if event.Layer != nil {
		return *event.Layer + ": " + event.Name
	}
	return event.Name
}

func wantsText(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "text/plain")
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(value)
}
