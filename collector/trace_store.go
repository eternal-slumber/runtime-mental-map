package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"sort"
	"sync"
	"time"
)

type Store struct {
	mu     sync.RWMutex
	traces map[string]map[string]Event
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

func (s *Store) addEvents(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	var events []Event
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&events); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := ensureJSONEnded(decoder); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if len(events) == 0 {
		http.Error(w, "events cannot be empty", http.StatusUnprocessableEntity)
		return
	}
	if len(events) > 10_000 {
		http.Error(w, "too many events", http.StatusRequestEntityTooLarge)
		return
	}
	for _, event := range events {
		if err := validate(event); err != nil {
			http.Error(w, err.Error(), http.StatusUnprocessableEntity)
			return
		}
	}
	for _, event := range events {
		if err := s.save(event); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
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
			return nil
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
		summary := TraceSummary{TraceID: traceID, ServiceName: events[0].ServiceName, Status: view.Status, SpanCount: len(events)}
		if view.Root != nil {
			summary.ServiceName = view.Root.ServiceName
			summary.Name = view.Root.Name
			summary.FlowID = view.Root.FlowID
			summary.ParentTraceID = view.Root.ParentTraceID
			summary.StartedAtUnixUS = view.Root.StartedAtUnixUS
			summary.DurationNS = view.Root.DurationNS
			summary.Outcome = view.Root.Outcome
			summary.HTTPStatus = view.Root.HTTPStatus
		}
		summaries = append(summaries, summary)
	}
	sort.Slice(summaries, func(i, j int) bool {
		if summaries[i].StartedAtUnixUS == summaries[j].StartedAtUnixUS {
			return summaries[i].TraceID < summaries[j].TraceID
		}

		return summaries[i].StartedAtUnixUS > summaries[j].StartedAtUnixUS
	})

	if wantsText(r) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		for _, summary := range summaries {
			name := summary.Name
			if name == "" {
				name = "[waiting for root]"
			}
			fmt.Fprintf(w, "%s  %s  [%s]  %s  %s  %d spans\n", summary.ServiceName, summary.TraceID, summary.Status,
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
		hideServiceSQL := r.URL.Query().Get("hide_service_sql") == "1"
		_, _ = io.WriteString(w, renderText(view, hideServiceSQL))
		return
	}
	writeJSON(w, view)
}
