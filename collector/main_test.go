package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIncompleteTraceBecomesComplete(t *testing.T) {
	controllerID, serviceID, requestID := "controller-1", "service-1", "request-1"
	events := []Event{
		testEvent("repository-1", &serviceID, "TestRepository::save", 4),
		testEvent("service-1", &controllerID, "TestService::run", 3),
		testEvent("request-1", nil, "POST /test", 1),
	}

	incomplete := buildTrace("trace-abc", events)
	if incomplete.Status != "incomplete" || len(incomplete.Orphans) != 1 {
		t.Fatalf("expected incomplete trace with one orphan, got %#v", incomplete)
	}
	if len(incomplete.MissingParents) != 1 || incomplete.MissingParents[0] != "controller-1" {
		t.Fatalf("unexpected missing parents: %v", incomplete.MissingParents)
	}

	events = append(events, testEvent("controller-1", &requestID, "TestController::store", 2))
	complete := buildTrace("trace-abc", events)
	if complete.Status != "complete" || complete.Root == nil || len(complete.Orphans) != 0 {
		t.Fatalf("expected complete trace, got %#v", complete)
	}
}

func TestBatchEndpointAcceptsChildrenBeforeRoot(t *testing.T) {
	store := &Store{traces: make(map[string]map[string]Event)}
	rootID := "request-1"
	root := testEvent(rootID, nil, "GET /test", 1)
	root.Kind = "request"
	child := testEvent("sql-1", &rootID, "SQL SELECT 1", 2)
	child.Kind = "sql"
	child.DurationNS = int64(1200 * time.Microsecond)
	body, err := json.Marshal([]Event{child, root})
	if err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/events/batch", bytes.NewReader(body))
	store.addEvents(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
	view := buildTrace("trace-abc", []Event{store.traces["trace-abc"][rootID], store.traces["trace-abc"]["sql-1"]})
	if view.Status != "complete" || view.Root == nil || len(view.Root.Children) != 1 {
		t.Fatalf("expected complete batch trace, got %#v", view)
	}
	if got := label(child); got != "SQL SELECT 1 1.2ms" {
		t.Fatalf("unexpected SQL label: %s", got)
	}
}

func TestInvalidEventsAreRejected(t *testing.T) {
	store := &Store{traces: make(map[string]map[string]Event)}
	root := testEvent("root-1", nil, "POST /test", 1)
	if err := store.save(root); err != nil {
		t.Fatal(err)
	}
	if err := store.save(root); err != nil {
		t.Fatalf("exact duplicate should be idempotent: %v", err)
	}

	changed := root
	changed.Name = "different"
	if err := store.save(changed); err == nil {
		t.Fatal("conflicting duplicate must be rejected")
	}
	if err := store.save(testEvent("root-2", nil, "GET /users", 2)); err == nil {
		t.Fatal("second root must be rejected")
	}

	self := "self"
	if err := validate(testEvent("self", &self, "self", 3)); err == nil {
		t.Fatal("self-parent must be rejected")
	}
}

func TestCycleIsRejected(t *testing.T) {
	store := &Store{traces: make(map[string]map[string]Event)}
	b, c, a := "B", "C", "A"
	if err := store.save(testEvent("A", &b, "A", 1)); err != nil {
		t.Fatal(err)
	}
	if err := store.save(testEvent("B", &c, "B", 2)); err != nil {
		t.Fatal(err)
	}
	if err := store.save(testEvent("C", &a, "C", 3)); err == nil {
		t.Fatal("cycle A -> B -> C -> A must be rejected")
	}
}

func TestTraceEndpointsReturnJSONAndText(t *testing.T) {
	controllerID := "controller-1"
	store := &Store{traces: map[string]map[string]Event{
		"trace-abc": {
			"service-1": testEvent("service-1", &controllerID, "TestService::run", 2),
		},
	}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /traces", store.getTraces)
	mux.HandleFunc("GET /traces/{traceID}", store.getTrace)

	jsonResponse := httptest.NewRecorder()
	mux.ServeHTTP(jsonResponse, httptest.NewRequest("GET", "/traces/trace-abc", nil))
	if jsonResponse.Code != http.StatusOK || !strings.Contains(jsonResponse.Body.String(), `"status": "incomplete"`) {
		t.Fatalf("unexpected JSON response: %d %s", jsonResponse.Code, jsonResponse.Body.String())
	}

	textRequest := httptest.NewRequest("GET", "/traces/trace-abc", nil)
	textRequest.Header.Set("Accept", "text/plain")
	textResponse := httptest.NewRecorder()
	mux.ServeHTTP(textResponse, textRequest)
	if !strings.Contains(textResponse.Body.String(), "missing parents:\n└── controller-1") {
		t.Fatalf("unexpected text response: %s", textResponse.Body.String())
	}

	listResponse := httptest.NewRecorder()
	mux.ServeHTTP(listResponse, httptest.NewRequest("GET", "/traces", nil))
	if listResponse.Code != http.StatusOK || !strings.Contains(listResponse.Body.String(), `"span_count": 1`) {
		t.Fatalf("unexpected list response: %d %s", listResponse.Code, listResponse.Body.String())
	}
}

func testEvent(spanID string, parentID *string, name string, startedAt int64) Event {
	return Event{
		TraceID: "trace-abc", SpanID: spanID, ParentID: parentID,
		Kind: "method", Runtime: "php", Framework: "laravel",
		Name: name, StartedAtUnixUS: startedAt,
	}
}
