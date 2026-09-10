package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func renderText(view TraceView, hideServiceSQL bool) string {
	var output strings.Builder
	fmt.Fprintf(&output, "Trace %s [%s]\n", view.TraceID, view.Status)
	if view.Root != nil {
		writeNode(&output, view.Root, "", "", hideServiceSQL)
	}
	orphans := visibleNodes(view.Orphans, hideServiceSQL)
	if len(orphans) > 0 {
		output.WriteString("orphan spans:\n")
		for i, orphan := range orphans {
			connector := "├── "
			if i == len(orphans)-1 {
				connector = "└── "
			}
			writeNode(&output, orphan, "", connector, hideServiceSQL)
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

func writeNode(output *strings.Builder, current *SpanNode, prefix, connector string, hideServiceSQL bool) {
	fmt.Fprintf(output, "%s%s%s\n", prefix, connector, label(current.Event))
	children := visibleNodes(current.Children, hideServiceSQL)
	for i, child := range children {
		childPrefix := prefix
		if connector == "└── " {
			childPrefix += "    "
		} else if connector != "" {
			childPrefix += "│   "
		}
		childConnector := "├── "
		if i == len(children)-1 {
			childConnector = "└── "
		}
		writeNode(output, child, childPrefix, childConnector, hideServiceSQL)
	}
}

func visibleNodes(nodes []*SpanNode, hideServiceSQL bool) []*SpanNode {
	if !hideServiceSQL {
		return nodes
	}
	visible := make([]*SpanNode, 0, len(nodes))
	for _, node := range nodes {
		if !isServiceSQL(node.Event) {
			visible = append(visible, node)
		}
	}
	return visible
}

func isServiceSQL(event Event) bool {
	return event.Kind == "sql" && strings.HasPrefix(event.Name, "SQL SET ")
}

func label(event Event) string {
	if event.Kind == "request" {
		result := "HTTP " + event.Name
		if event.HTTPStatus != nil {
			result += fmt.Sprintf(" [%d %s]", *event.HTTPStatus, event.Outcome)
		}
		return result
	}

	result := event.Name
	if event.Layer != nil {
		result = *event.Layer + ": " + result
	}
	if event.Outcome == "exception" {
		result += " ⚠"
		if event.ErrorType != nil {
			result += " " + *event.ErrorType
		}
		if event.ErrorMessage != nil {
			result += ": " + *event.ErrorMessage
		}
	}
	if event.Kind == "sql" {
		result += " " + time.Duration(event.DurationNS).String()
	}
	return result
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
