package main

import (
	"encoding/json"
	"errors"
	"io"
)

type Event struct {
	ProtocolVersion int    `json:"protocol_version"`
	ServiceName     string `json:"service_name"`

	TraceID         string  `json:"trace_id"`
	SpanID          string  `json:"span_id"`
	ParentID        *string `json:"parent_id"`
	FlowID          *string `json:"flow_id,omitempty"`
	ParentTraceID   *string `json:"parent_trace_id,omitempty"`
	Kind            string  `json:"kind"`
	Runtime         string  `json:"runtime"`
	Framework       string  `json:"framework"`
	Layer           *string `json:"layer"`
	Name            string  `json:"name"`
	Class           *string `json:"class"`
	Method          *string `json:"method"`
	StartedAtUnixUS int64   `json:"started_at_unix_us"`
	DurationNS      int64   `json:"duration_ns"`

	Outcome      string  `json:"outcome,omitempty"`
	HTTPStatus   *int    `json:"http_status,omitempty"`
	ErrorType    *string `json:"error_type,omitempty"`
	ErrorMessage *string `json:"error_message,omitempty"`
	ErrorFile    *string `json:"error_file,omitempty"`
	ErrorLine    *int    `json:"error_line,omitempty"`
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
	TraceID         string  `json:"trace_id"`
	ServiceName     string  `json:"service_name"`
	FlowID          *string `json:"flow_id,omitempty"`
	ParentTraceID   *string `json:"parent_trace_id,omitempty"`
	Status          string  `json:"status"`
	Name            string  `json:"name"`
	StartedAtUnixUS int64   `json:"started_at_unix_us"`
	DurationNS      int64   `json:"duration_ns"`
	SpanCount       int     `json:"span_count"`
	Outcome         string  `json:"outcome,omitempty"`
	HTTPStatus      *int    `json:"http_status,omitempty"`
}

func validate(event Event) error {
	if event.ProtocolVersion != 1 {
		return errors.New("unsupported protocol_version")
	}
	if event.ServiceName == "" {
		return errors.New("service_name is required")
	}
	if event.TraceID == "" {
		return errors.New("trace_id is required")
	}
	if event.SpanID == "" {
		return errors.New("span_id is required")
	}
	if event.Name == "" {
		return errors.New("name is required")
	}
	if event.FlowID != nil {
		if len(*event.FlowID) == 0 || len(*event.FlowID) > 128 {
			return errors.New("flow_id must contain between 1 and 128 characters")
		}
	}
	if event.ParentTraceID != nil {
		if len(*event.ParentTraceID) == 0 || len(*event.ParentTraceID) > 128 {
			return errors.New("parent_trace_id must contain between 1 and 128 characters")
		}

		if *event.ParentTraceID == event.TraceID {
			return errors.New("trace cannot be its own parent")
		}
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
	switch event.Outcome {
	case "", "success", "client_error", "server_error", "exception":
	default:
		return errors.New("invalid outcome")
	}
	if event.HTTPStatus != nil && (*event.HTTPStatus < 100 || *event.HTTPStatus > 599) {
		return errors.New("http_status must be between 100 and 599")
	}
	if event.ErrorLine != nil && *event.ErrorLine < 1 {
		return errors.New("error_line must be positive")
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
