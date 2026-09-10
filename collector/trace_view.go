package main

import "sort"

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
