import { Component, useCallback, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import type { Viewport } from '@xyflow/react'
import './App.css'
import {
  TraceCanvas,
  type CanvasSelection,
  type CanvasFieldState,
  type CanvasGroup,
  type CanvasManualEdge,
  type CanvasNodeState,
  type CanvasNote,
} from './TraceCanvas'
import {
  groupGraphByClass,
  groupDuration,
  querySource,
  sourceLabel,
  summarizeGroupMembers,
  traceToGraph,
  type TraceView,
} from './traceGraph'

import { architectureFields, fieldState, initialLayout, type Point } from './canvasLayout'
import { buildTraceFlows, type TimelineNode } from './traceTimeline'

type TraceSummary = {
  trace_id: string
  service_name: string
  flow_id?: string
  parent_trace_id?: string
  started_at_unix_us: number
  status: string
  name: string
  duration_ns: number
  span_count: number
  outcome?: string
  http_status?: number
}

type MentalMapSummary = {
  id: string
  service_name: string
  title: string
  created_at: string
}

type MentalMap = MentalMapSummary & {
  source_trace_ids: string[]
  viewport: Viewport
  nodes: Array<CanvasNodeState & { runtime_node_id: string }>
  notes: CanvasNote[]
  groups: CanvasGroup[]
  fields?: CanvasFieldState[]
  manual_edges: CanvasManualEdge[]
  sequence_names: Record<string, string>
  trace: TraceView
}

function formatDuration(durationNs: number): string {
  return `${(durationNs / 1_000_000).toFixed(2)} ms`
}

function formatTime(startedAtUnixUS: number): string {
  if (!Number.isFinite(startedAtUnixUS) || startedAtUnixUS <= 0) return 'time unavailable'
  return new Date(startedAtUnixUS / 1_000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function TraceTimeline({
  nodes,
  selectedTraceId,
  onSelect,
  nested = false,
}: {
  nodes: TimelineNode<TraceSummary>[]
  selectedTraceId: string | null
  onSelect: (traceId: string) => void
  nested?: boolean
}) {
  return <ul className={`trace-list timeline-list ${nested ? 'timeline-children' : ''}`}>
    {nodes.map((node) => <li className="timeline-item" key={node.trace.trace_id}>
      <button
        className="trace-select"
        type="button"
        aria-pressed={selectedTraceId === node.trace.trace_id}
        onClick={() => onSelect(node.trace.trace_id)}
      >
        <span>{node.trace.service_name} · {formatTime(node.trace.started_at_unix_us)}</span>
        <strong>{node.trace.name || 'Waiting for root'}</strong>
        <small>
          {node.trace.http_status ?? node.trace.status} · {formatDuration(node.trace.duration_ns)} ·{' '}
          {node.trace.span_count} spans
        </small>
      </button>
      {node.children.length > 0 && <TraceTimeline
        nodes={node.children}
        selectedTraceId={selectedTraceId}
        onSelect={onSelect}
        nested
      />}
    </li>)}
  </ul>
}

class WorkspaceErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error('Runtime canvas failed', error, info)
  }

  render() {
    if (this.state.failed) return <div className="canvas-fallback">
      <p>Canvas could not be rendered. Runtime data is still available.</p>
      <button type="button" onClick={() => this.setState({ failed: false })}>Retry canvas</button>
    </div>
    return this.props.children
  }
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('runtime-map-theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const [traces, setTraces] = useState<TraceSummary[]>([])
  const [maps, setMaps] = useState<MentalMapSummary[]>([])
  const [selectedMap, setSelectedMap] = useState<MentalMap | null>(null)
  const [nodeStates, setNodeStates] = useState<Record<string, CanvasNodeState>>({})
  const [notes, setNotes] = useState<CanvasNote[]>([])
  const [groups, setGroups] = useState<CanvasGroup[]>([])
  const [fieldStates, setFieldStates] = useState<CanvasFieldState[]>([])
  const [manualEdges, setManualEdges] = useState<CanvasManualEdge[]>([])
  const [sequenceNames, setSequenceNames] = useState<Record<string, string>>({})
  const [savedViewport, setSavedViewport] = useState<Viewport | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [selectedTrace, setSelectedTrace] = useState<TraceView | null>(null)
  const [traceError, setTraceError] = useState<string | null>(null)
  const [traceLoading, setTraceLoading] = useState(false)
  const [showServiceQueries, setShowServiceQueries] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selection, setSelection] = useState<CanvasSelection>(null)
  const [inspectorVisible, setInspectorVisible] = useState(false)

  useEffect(() => {
    localStorage.setItem('runtime-map-theme', theme)
    document.documentElement.style.colorScheme = theme
  }, [theme])
  const selectNode = useCallback((id: string | null, detail: CanvasSelection = null) => {
    setSelectedNodeId(id)
    setSelection(detail)
    if (id === null) setInspectorVisible(false)
  }, [])
  const inspectNode = useCallback((id: string, detail: CanvasSelection = null) => {
    selectNode(id, detail)
    setInspectorVisible(true)
  }, [selectNode])
  const moveNodes = useCallback((positions: Record<string, Point>) => {
    setNodeStates((current) => {
      const next = { ...current }
      let changed = false
      for (const [id, position] of Object.entries(positions)) {
        if (current[id]?.x === position.x && current[id]?.y === position.y) continue
        next[id] = { ...(current[id] ?? { hidden: false, collapsed: false, pinned: false }), ...position }
        changed = true
      }
      return changed ? next : current
    })
  }, [])
  const updateFields = useCallback((fields: CanvasFieldState[], positions: Record<string, Point>) => {
    setFieldStates(fields)
    moveNodes(positions)
  }, [moveNodes])
  const toggleCollapse = useCallback((id: string) => {
    setNodeStates((current) => current[id] ? {
      ...current, [id]: { ...current[id], collapsed: !current[id].collapsed },
    } : current)
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    async function loadTraces() {
      try {
        const response = await fetch('/api/traces', {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`Collector returned HTTP ${response.status}`)
        }

        const data: TraceSummary[] = await response.json()
        setTraces(data)
        setError(null)
      } catch (error) {
        if (error instanceof Error && error.name !== 'AbortError') {
          setError(error.message)
        }
      } finally {
        setLoading(false)
      }
    }

    void loadTraces()

    const intervalId = window.setInterval(() => {
      void loadTraces()
    }, 2_000)

    return () => {
      window.clearInterval(intervalId)
      controller.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/maps', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Collector returned HTTP ${response.status}`)
        }
        return response.json() as Promise<MentalMapSummary[]>
      })
      .then(setMaps)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name !== 'AbortError') {
          setError(error.message)
        }
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (selectedTraceId === null) {
      return
    }

    const traceId = selectedTraceId
    const controller = new AbortController()

    async function loadTrace() {
      setTraceLoading(true)
      setTraceError(null)
      setSelectedTrace(null)

      try {
        const response = await fetch(
          `/api/traces/${encodeURIComponent(traceId)}`,
          { signal: controller.signal },
        )

        if (!response.ok) {
          throw new Error(`Collector returned HTTP ${response.status}`)
        }

        const data: TraceView = await response.json()
        setSelectedTrace(data)
      } catch (error) {
        if (error instanceof Error && error.name !== 'AbortError') {
          setTraceError(error.message)
        }
      } finally {
        if (!controller.signal.aborted) {
          setTraceLoading(false)
        }
      }
    }

    void loadTrace()

    return () => controller.abort()
  }, [selectedTraceId])

  const rawGraph = useMemo(() => selectedTrace ? traceToGraph(selectedTrace) : null, [selectedTrace])
  const selectedGraph = useMemo(
    () => selectedTrace === null
      ? null
      : traceToGraph(selectedTrace, !showServiceQueries),
    [selectedTrace, showServiceQueries],
  )
  const displayGraph = useMemo(
    () => selectedGraph === null ? null : groupGraphByClass(selectedGraph),
    [selectedGraph],
  )
  const positionedNodes = useMemo(() => displayGraph ? initialLayout(displayGraph, nodeStates, fieldStates).map((box) => ({
    ...box, position: { x: box.x, y: box.y },
  })) : [], [displayGraph, nodeStates, fieldStates])
  const selectedNode = displayGraph?.nodes.find(
    (node) => node.id === selectedNodeId,
  ) ?? null
  const selectedNote = notes.find((note) => note.id === selectedNodeId) ?? null
  const selectedGroup = groups.find((group) => group.id === selectedNodeId) ?? null
  const primaryNode = selectedNode?.members[0] ?? null
  const selectedMembers = selection && selection.nodeId === selectedNodeId
    ? selectedNode?.members.filter((member) => selection.spanIds.includes(member.id)) ?? [] : []
  const selectedMemberIds = new Set(selectedMembers.map((member) => member.id))
  const callers = rawGraph?.edges.filter((edge) => selectedMemberIds.has(edge.target)).map((edge) => rawGraph.nodes.find((node) => node.id === edge.source)!) ?? []
  const callees = rawGraph?.edges.filter((edge) => selectedMemberIds.has(edge.source)).map((edge) => rawGraph.nodes.find((node) => node.id === edge.target)!) ?? []
  const selectedMemberSummaries = selectedNode === null
    ? []
    : summarizeGroupMembers(selectedNode)
  const selectedChildren = selectedNode?.members.flatMap(
    (node) => node.span.children.filter(
      (child) => child.class !== primaryNode?.className,
    ),
  ) ?? []
  const selectedSummary = traces.find(
    (trace) => trace.trace_id === selectedTraceId,
  ) ?? null
  const traceFlows = useMemo(() => buildTraceFlows(traces), [traces])
  const inspectorOpen = inspectorVisible && (selectedNote !== null
    || selectedGroup !== null
    || (selectedNode !== null && primaryNode !== null))

  useEffect(() => {
    if (!inspectorOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInspectorVisible(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [inspectorOpen])

  async function openMap(mapId: string): Promise<void> {
    setTraceLoading(true)
    setTraceError(null)
    try {
      const response = await fetch(`/api/maps/${encodeURIComponent(mapId)}`)
      if (!response.ok) {
        throw new Error(`Collector returned HTTP ${response.status}`)
      }
      const mentalMap: MentalMap = await response.json()
      setSelectedTraceId(null)
      setSelectedMap(mentalMap)
      setSelectedTrace(mentalMap.trace)
      selectNode(null)
      setSavedViewport(mentalMap.viewport)
      setNotes(mentalMap.notes ?? [])
      const legacyFields = (mentalMap.groups ?? [])
        .filter((group) => group.id.startsWith('field:'))
        .map((group) => ({
          layer: group.id.slice(6) as CanvasFieldState['layer'],
          x: group.x,
          width: group.width,
          manual_min_width: group.width,
        }))
      setFieldStates(mentalMap.fields ?? legacyFields)
      setGroups((mentalMap.groups ?? []).filter((group) => !group.id.startsWith('field:')))
      setManualEdges(mentalMap.manual_edges ?? [])
      setSequenceNames(mentalMap.sequence_names ?? {})
      setNodeStates(Object.fromEntries(mentalMap.nodes.map((node) => [
        node.runtime_node_id,
        {
          x: node.x,
          y: node.y,
          hidden: node.hidden,
          collapsed: node.collapsed,
          pinned: node.pinned ?? false,
        },
      ])))
    } catch (error) {
      if (error instanceof Error) {
        setTraceError(error.message)
      }
    } finally {
      setTraceLoading(false)
    }
  }

  function mapPayload(title: string): Omit<MentalMap, 'id' | 'created_at'> | null {
    if (selectedTrace === null || displayGraph === null) {
      return null
    }
    const nodes = positionedNodes.map((node) => ({
      runtime_node_id: node.id,
      x: node.position.x,
      y: nodeStates[node.id]?.y ?? node.position.y,
      hidden: nodeStates[node.id]?.hidden ?? false,
      collapsed: nodeStates[node.id]?.collapsed ?? false,
      pinned: nodeStates[node.id]?.pinned ?? false,
    }))
    const includedIds = new Set(nodes.map((node) => node.runtime_node_id))
    for (const [id, state] of Object.entries(nodeStates)) {
      if (!includedIds.has(id)) nodes.push({ runtime_node_id: id, ...state })
    }
    return {
      service_name: selectedTrace.root?.service_name ?? 'unknown',
      title,
      source_trace_ids: selectedMap?.source_trace_ids ?? [selectedTrace.trace_id],
      viewport: savedViewport ?? { x: 0, y: 0, zoom: 1 },
      nodes,
      notes,
      groups,
      fields: fieldStates.length ? fieldStates : fieldState(architectureFields(displayGraph)),
      manual_edges: manualEdges,
      sequence_names: sequenceNames,
      trace: selectedTrace,
    }
  }

  async function saveMap(): Promise<void> {
    const title = window.prompt('Map name', selectedTrace?.root?.name ?? '')?.trim()
    if (!title) {
      return
    }
    const payload = mapPayload(title)
    if (payload === null) {
      return
    }
    setSaving(true)
    try {
      const response = await fetch('/api/maps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        throw new Error(`Collector returned HTTP ${response.status}`)
      }
      const mentalMap: MentalMap = await response.json()
      setSelectedTraceId(null)
      setSelectedMap(mentalMap)
      setMaps((current) => [mentalMap, ...current])
    } catch (error) {
      if (error instanceof Error) {
        setTraceError(error.message)
      }
    } finally {
      setSaving(false)
    }
  }

  async function updateMap(): Promise<void> {
    if (selectedMap === null) {
      return
    }
    const payload = mapPayload(selectedMap.title)
    if (payload === null) {
      return
    }
    setSaving(true)
    try {
      const response = await fetch(`/api/maps/${encodeURIComponent(selectedMap.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        throw new Error(`Collector returned HTTP ${response.status}`)
      }
      const updated = await response.json() as MentalMap
      setSelectedMap(updated)
      setMaps((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (error) {
      if (error instanceof Error) {
        setTraceError(error.message)
      }
    } finally {
      setSaving(false)
    }
  }

  function selectedPosition(): { x: number; y: number } | null {
    if (selectedNode === null || displayGraph === null) {
      return null
    }
    const fallback = positionedNodes.find(
      (node) => node.id === selectedNode.id,
    )?.position
    return nodeStates[selectedNode.id] ?? fallback ?? null
  }

  function addNote(): void {
    const position = selectedPosition()
    const text = window.prompt('Note text')?.trim()
    if (position === null || !text) {
      return
    }
    const id = `note:${crypto.randomUUID()}`
    setNotes((current) => [...current, {
      id,
      text,
      x: position.x + 300,
      y: position.y,
      pinned: false,
    }])
    setManualEdges((current) => [...current, {
      id: `edge:${id}:${selectedNode?.id}`,
      source: id,
      target: selectedNode!.id,
    }])
    selectNode(id)
  }

  function addGroup(): void {
    const position = selectedPosition()
    const title = window.prompt('Group name')?.trim()
    if (position === null || !title || selectedNode === null) {
      return
    }
    const id = `group:${crypto.randomUUID()}`
    setGroups((current) => [...current, {
      id,
      title,
      x: position.x - 24,
      y: position.y - 48,
      width: 298,
      height: 190,
      runtime_node_ids: [selectedNode.id],
    }])
    selectNode(id)
  }

  function moveObject(id: string, x: number, y: number): void {
    if (id.startsWith('note:')) {
      setNotes((current) => current.map((note) => note.id === id ? { ...note, x, y } : note))
      return
    }
    if (id.startsWith('group:')) {
      setGroups((current) => current.map((group) => group.id === id ? { ...group, x, y } : group))
      return
    }
    setNodeStates((current) => ({
      ...current,
      [id]: {
        x,
        y,
        hidden: current[id]?.hidden ?? false,
        collapsed: current[id]?.collapsed ?? false,
        pinned: current[id]?.pinned ?? false,
      },
    }))
  }

  function openTrace(traceId: string): void {
    selectNode(null)
    setSelectedMap(null)
    setNodeStates({})
    setNotes([])
    setGroups([])
    setFieldStates([])
    setManualEdges([])
    setSequenceNames({})
    setSavedViewport(null)
    setSelectedTraceId(traceId)
  }

  return (
    <main className="workspace" data-theme={theme}>
      <aside className="trace-sidebar">
        <header className="sidebar-header">
          <h1>Mental Map</h1>
          <button
            className="theme-toggle"
            type="button"
            aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </header>

        <header className="sidebar-section">
          <h2>Traces <span>{traces.length}</span></h2>
        </header>

        {loading && <p className="message">Loading traces…</p>}
        {error !== null && <p className="message error">{error}</p>}
        {!loading && error === null && traces.length === 0 && (
          <p className="message">No traces yet.</p>
        )}

        <div className="flow-list">
          {traceFlows.map((flow) => <section className="flow-group" key={flow.id}>
            {flow.correlated && <header className="flow-header" title={flow.id}>
              <strong>{flow.serviceName}</strong>
              <span>{flow.requestCount} requests · {formatTime(flow.startedAtUnixUS)}</span>
            </header>}
            <TraceTimeline
              nodes={flow.nodes}
              selectedTraceId={selectedTraceId}
              onSelect={openTrace}
            />
          </section>)}
        </div>

        <header className="sidebar-section">
          <h2>Maps</h2>
        </header>
        {maps.length === 0 && <p className="message">No saved maps yet.</p>}
        <ul className="trace-list">
          {maps.map((mentalMap) => (
            <li key={mentalMap.id}>
              <button
                className="trace-select"
                type="button"
                aria-pressed={selectedMap?.id === mentalMap.id}
                onClick={() => void openMap(mentalMap.id)}
              >
                <span>{mentalMap.service_name}</span>
                <strong>{mentalMap.title}</strong>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="trace-main">
        {selectedTrace === null && !traceLoading && (
          <p className="empty-workspace">Select a trace or map from the sidebar.</p>
        )}
        {traceLoading && <p className="empty-workspace">Loading trace…</p>}
        {traceError !== null && <p className="empty-workspace error">{traceError}</p>}

        {selectedTrace !== null && selectedGraph !== null && displayGraph !== null && (
          <>
            <header className="trace-toolbar">
              <div>
                <h2>{selectedMap?.title ?? selectedSummary?.name ?? selectedTrace.root?.name}</h2>
                <p>
                  {selectedTrace.root?.http_status ?? selectedTrace.status} ·{' '}
                  {formatDuration(selectedTrace.root?.duration_ns ?? 0)} ·{' '}
                  {selectedGraph.nodes.length} spans · {displayGraph.nodes.length} nodes
                </p>
              </div>
              <div className="toolbar-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={showServiceQueries}
                    onChange={(event) => setShowServiceQueries(event.target.checked)}
                  />{' '}
                  Show service queries
                </label>
                {selectedMap !== null && (
                  <>
                    <button type="button" onClick={() => {
                      const title = window.prompt('Map name', selectedMap.title)?.trim()
                      if (title) {
                        setSelectedMap({ ...selectedMap, title })
                      }
                    }}>Rename</button>
                    <button type="button" disabled={selectedNode === null} onClick={addNote}>
                      Add note
                    </button>
                    <button type="button" disabled={selectedNode === null} onClick={addGroup}>
                      Add group
                    </button>
                    {Object.values(nodeStates).some((node) => node.hidden) && (
                      <button type="button" onClick={() => setNodeStates((current) => Object.fromEntries(
                        Object.entries(current).map(([id, node]) => [id, { ...node, hidden: false }]),
                      ))}>
                        Show hidden
                      </button>
                    )}
                  </>
                )}
                <button type="button" onClick={() => {
                  const resetFields = architectureFields(displayGraph, fieldStates.map((field) => ({
                    ...field,
                    width: field.manual_min_width,
                  })))
                  setFieldStates(fieldState(resetFields))
                  const arranged = initialLayout(
                    displayGraph,
                    Object.fromEntries(Object.entries(nodeStates).filter(([, node]) => node.pinned)),
                    fieldState(resetFields),
                  )
                  moveNodes(Object.fromEntries(arranged.filter((box) => !nodeStates[box.id]?.pinned).map((box) => [box.id, { x: box.x, y: box.y }])))
                }}>Auto layout</button>
                <button className="primary-action" type="button" disabled={saving} onClick={() => {
                  void (selectedMap === null ? saveMap() : updateMap())
                }}>
                  {saving ? 'Saving…' : selectedMap === null ? 'Save as map' : 'Save changes'}
                </button>
              </div>
            </header>

            <div className="trace-workspace">
              <WorkspaceErrorBoundary key={selectedMap?.id ?? selectedTrace.trace_id}>
              <TraceCanvas
                graph={displayGraph}
                selectedNodeId={selectedNodeId}
                nodeStates={nodeStates}
                fieldStates={fieldStates}
                notes={notes}
                groups={groups}
                manualEdges={manualEdges}
                sequenceNames={sequenceNames}
                savedViewport={savedViewport}
                selection={selection}
                onNodeSelect={selectNode}
                onInspect={inspectNode}
                onPositionsChange={moveNodes}
                onToggleCollapse={toggleCollapse}
                onFieldsChange={updateFields}
                onObjectPositionChange={moveObject}
                onViewportChange={setSavedViewport}
              />

              {inspectorOpen && <div className="inspector-overlay" onMouseDown={(event) => {
                if (event.target === event.currentTarget) setInspectorVisible(false)
              }}>
              <aside className="trace-inspector" role="dialog" aria-modal="true" aria-live="polite">
                <div className="inspector-content">
                <button
                  className="inspector-close"
                  type="button"
                  aria-label="Close inspector"
                  onClick={() => setInspectorVisible(false)}
                >
                  ×
                </button>
                {selectedNote !== null ? (
                  <>
                    <h2>Note</h2>
                    <p>{selectedNote.text}</p>
                    <button type="button" onClick={() => {
                      const text = window.prompt('Note text', selectedNote.text)?.trim()
                      if (text) {
                        setNotes((current) => current.map(
                          (note) => note.id === selectedNote.id ? { ...note, text } : note,
                        ))
                      }
                    }}>Edit</button>{' '}
                    <button type="button" onClick={() => setNotes((current) => current.map(
                      (note) => note.id === selectedNote.id
                        ? { ...note, pinned: !note.pinned }
                        : note,
                    ))}>
                      {selectedNote.pinned ? 'Unpin' : 'Pin'}
                    </button>
                  </>
                ) : selectedGroup !== null ? (
                  <>
                    <h2>{selectedGroup.title}</h2>
                    <p>{selectedGroup.runtime_node_ids.length} runtime nodes</p>
                    <button type="button" onClick={() => {
                      const title = window.prompt('Group name', selectedGroup.title)?.trim()
                      if (title) {
                        setGroups((current) => current.map(
                          (group) => group.id === selectedGroup.id ? { ...group, title } : group,
                        ))
                      }
                    }}>Rename group</button>
                  </>
                ) : selectedNode === null || primaryNode === null ? (
                  <p>Select a node to inspect it.</p>
                ) : (
                  <>
                    {selectedMembers.length > 0 && <section className="inspector-selection">
                      <h2>{selection?.kind === 'query' ? 'Query' : `${selectedMembers[0].methodName}()`}</h2>
                      <dl>
                        {selection?.kind === 'query' && <><dt>Operation</dt><dd>{selectedMembers[0].label.match(/\b(SELECT|INSERT|UPDATE|DELETE|WITH|SET|BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|DROP)\b/i)?.[0].toUpperCase() ?? 'SQL'}</dd></>}
                        <dt>Total</dt><dd>{formatDuration(selectedMembers.reduce((sum, node) => sum + node.durationNs, 0))}</dd>
                        <dt>Self</dt><dd>{formatDuration(selectedMembers.reduce((sum, node) => sum + node.selfDurationNs, 0))}</dd>
                        <dt>Repetitions</dt><dd>{selectedMembers.length}</dd>
                        {selection?.kind === 'query' && <>
                          <dt>Caller</dt><dd>{sourceLabel(querySource(selectedMembers[0], displayGraph))}</dd>
                          <dt>Layer</dt><dd>{selectedMembers[0].lane}</dd>
                          <dt>Trace</dt><dd>{selectedMembers[0].span.trace_id}</dd>
                        </>}
                      </dl>
                      {selection?.kind === 'query' ? <>
                        <pre>{selectedMembers[0].label.replace(/^SQL\s+/, '')}</pre>
                        {selectedMembers[0].label.replace(/^SQL\s+/, '').length >= 300 && <p>SQL may be truncated by the agent.</p>}
                        <p>Parameters are not provided by this trace.</p>
                      </> : <>
                        <h3>Callers</h3><ul>{[...new Set(callers.map(sourceLabel))].map((label) => <li key={label}>{label}</li>)}</ul>
                        <h3>Callees</h3><ul>{[...new Set(callees.map(sourceLabel))].map((label) => <li key={label}>{label}</li>)}</ul>
                      </>}
                    </section>}
                    <h2>{primaryNode.kind === 'sql' ? 'Database'  : primaryNode.shortClassName ?? primaryNode.label}</h2>
                    <dl>
                      <dt>Layer</dt><dd>{selectedNode.lane}</dd>
                      <dt>Kind</dt>
                      <dd>{primaryNode.kind === 'sql'
                        ? 'query group'
                        : selectedNode.members.length > 1 ? 'class group' : primaryNode.kind}</dd>
                      <dt>{primaryNode.kind === 'sql' ? 'Queries' : 'Spans'}</dt>
                      <dd>{selectedNode.members.length}</dd>
                      <dt>Class</dt><dd>{primaryNode.className ?? '—'}</dd>
                      <dt>Total</dt><dd>{formatDuration(groupDuration(selectedNode, displayGraph))}</dd>
                      <dt>Self</dt><dd>{formatDuration(selectedNode.members.reduce((sum, node) => sum + node.selfDurationNs, 0))}</dd>
                      <dt>Source file</dt><dd>{primaryNode.span.error_file ? `${primaryNode.span.error_file}:${primaryNode.span.error_line ?? '?'} (exception)` : 'Not provided by this trace'}</dd>
                      <dt>Trace</dt><dd>{primaryNode.span.trace_id}</dd>
                    </dl>

                    {primaryNode.kind !== 'sql' && <><button type="button" onClick={() => toggleCollapse(selectedNode.id)}>
                      {nodeStates[selectedNode.id]?.collapsed ? 'Expand node' : 'Collapse node'}
                    </button>{' '}</>}
                    <button type="button" onClick={() => {
                      const positioned = positionedNodes.find(
                        (node) => node.id === selectedNode.id,
                      )
                      if (positioned === undefined) {
                        return
                      }
                      setNodeStates((current) => ({
                        ...current,
                        [selectedNode.id]: {
                          x: current[selectedNode.id]?.x ?? positioned.position.x,
                          y: current[selectedNode.id]?.y ?? positioned.position.y,
                          hidden: current[selectedNode.id]?.hidden ?? false,
                          collapsed: current[selectedNode.id]?.collapsed ?? false,
                          pinned: !(current[selectedNode.id]?.pinned ?? false),
                        },
                      }))
                    }}>
                      {nodeStates[selectedNode.id]?.pinned ? 'Unpin node' : 'Pin node'}
                    </button>
                    {' '}
                    <button type="button" onClick={() => {
                      const positioned = positionedNodes.find(
                        (node) => node.id === selectedNode.id,
                      )
                      if (positioned === undefined) {
                        return
                      }
                      setNodeStates((current) => ({
                        ...current,
                        [selectedNode.id]: {
                          x: current[selectedNode.id]?.x ?? positioned.position.x,
                          y: current[selectedNode.id]?.y ?? positioned.position.y,
                          hidden: true,
                          collapsed: current[selectedNode.id]?.collapsed ?? false,
                          pinned: current[selectedNode.id]?.pinned ?? false,
                        },
                      }))
                      selectNode(null)
                    }}>Hide node</button>

                    <details key={selectedNode.id} open={primaryNode.kind !== 'sql'}>
                    <summary>{primaryNode.kind === 'sql'
                      ? 'Queries'
                      : primaryNode.className === null ? 'Span' : 'Methods'}</summary>
                    <ul>
                      {selectedMemberSummaries.map((summary) => (
                        <li key={summary.key}>
                          {summary.labels.length > 1
                            ? `${sequenceNames[summary.key] ?? 'Repeated sequence'} ×${summary.count}: ${summary.labels.join(' → ')}`
                            : summary.labels[0]}
                          {summary.labels.length === 1 && summary.count > 1
                            ? ` ×${summary.count}`
                            : ''}
                          {' — '}{formatDuration(summary.totalDurationNs)} total,{' '}
                          {formatDuration(summary.totalSelfDurationNs)} self
                          {summary.errorCount > 0 ? `, ${summary.errorCount} errors` : ''}
                          {selectedMap !== null && summary.labels.length > 1 && (
                            <> {' '}<button type="button" onClick={() => {
                              const name = window.prompt(
                                'Sequence name',
                                sequenceNames[summary.key] ?? 'Repeated sequence',
                              )?.trim()
                              if (name) {
                                setSequenceNames((current) => ({
                                  ...current,
                                  [summary.key]: name,
                                }))
                              }
                            }}>Rename</button></>
                          )}
                        </li>
                      ))}
                    </ul>

                    </details>
                    {primaryNode.kind !== 'sql' && selectedNode.members.length > 1 && (
                      <details>
                        <summary>Exact call sequence ({selectedNode.members.length})</summary>
                        <ol>
                          {selectedNode.members.map((node) => (
                            <li key={node.id}>
                              {node.methodName === null ? node.label : `${node.methodName}()`}
                              {' — '}{formatDuration(node.durationNs)}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}

                    {primaryNode.kind === 'sql' && <>
                      <h2>Callers</h2><ul>{[...new Set(selectedNode.members.map((query) => sourceLabel(querySource(query, displayGraph))))].map((label) => <li key={label}>{label}</li>)}</ul>
                    </>}
                    <h2>Children</h2>
                    {selectedChildren.length === 0 ? <p>None</p> : (
                      <ul>
                        {selectedChildren.map((child) => (
                          <li key={child.span_id}>
                            {child.name} — {formatDuration(child.duration_ns)}
                          </li>
                        ))}
                      </ul>
                    )}

                    <details>
                      <summary>Exact call sequence · entire trace ({rawGraph?.nodes.length})</summary>
                      <ol>{rawGraph?.nodes.map((node) => <li key={node.id}>
                        <strong>#{node.sequence + 1} {sourceLabel(node)}</strong> — {formatDuration(node.durationNs)}
                        <small className="exact-parent">span: {node.id} · parent: {node.span.parent_id ?? 'root'}</small>
                      </li>)}</ol>
                    </details>
                    <details>
                      <summary>Raw trace JSON</summary>
                      <pre>{JSON.stringify(selectedTrace, null, 2)}</pre>
                    </details>
                  </>
                )}
                </div>
              </aside>
              </div>}
              </WorkspaceErrorBoundary>
            </div>
          </>
        )}
      </section>
    </main>
  )
}

export default App
