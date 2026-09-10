import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow,
  useNodesState, useUpdateNodeInternals, type Edge, type Node, type NodeProps, type Viewport,
} from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  focusExecution, groupDuration, methodRows, querySections, querySource, sourceLabel,
  type GroupedCanvasGraph, type GroupedCanvasNode,
} from './traceGraph'
import {
  architectureFields,
  clampPositionToField,
  fieldState,
  initialLayout,
  MIN_FIELD_WIDTH,
  resizeField,
  safePosition,
  type ArchitectureField,
  type Box,
  type Point,
  type SavedField,
} from './canvasLayout'

export type CanvasSelection = { nodeId: string; spanIds: string[]; kind: 'method' | 'query' } | null
export type CanvasFieldState = SavedField

type TraceCanvasProps = {
  graph: GroupedCanvasGraph
  selectedNodeId: string | null
  selection: CanvasSelection
  nodeStates: Record<string, CanvasNodeState>
  fieldStates: SavedField[]
  notes: CanvasNote[]
  groups: CanvasGroup[]
  manualEdges: CanvasManualEdge[]
  sequenceNames: Record<string, string>
  savedViewport: Viewport | null
  onNodeSelect: (nodeId: string | null, selection?: CanvasSelection) => void
  onInspect: (nodeId: string, selection?: CanvasSelection) => void
  onPositionsChange: (positions: Record<string, Point>) => void
  onObjectPositionChange: (nodeId: string, x: number, y: number) => void
  onToggleCollapse: (nodeId: string) => void
  onFieldsChange: (fields: SavedField[], positions: Record<string, Point>) => void
  onViewportChange: (viewport: Viewport) => void
}

export type CanvasNodeState = {
  x: number
  y: number
  hidden: boolean
  collapsed: boolean
  pinned: boolean
}
export type CanvasNote = { id: string; text: string; x: number; y: number; pinned: boolean }
export type CanvasGroup = { id: string; title: string; x: number; y: number; width: number; height: number; runtime_node_ids: string[] }
export type CanvasManualEdge = { id: string; source: string; target: string }

type CardData = {
  group: GroupedCanvasNode
  graph: GroupedCanvasGraph
  detail: 'overview' | 'normal' | 'detail'
  collapsed: boolean
  focused: Set<string> | null
  selection: CanvasSelection
  sequenceNames: Record<string, string>
  onSelect: TraceCanvasProps['onNodeSelect']
  onInspect: TraceCanvasProps['onInspect']
  onToggle: () => void
}
type CardNode = Node<CardData>
const duration = (ns: number) => `${(ns / 1_000_000).toFixed(2)} ms`

function queryTarget(sql: string): string {
  const target = sql.match(
    /\b(?:FROM|INTO|UPDATE|TABLE)\s+([`"[]?[\w.]+[`"\]]?)/i,
  )?.[1]
  return target?.replace(/[`"[\]]/g, '') ?? 'database'
}

function shortSource(group: GroupedCanvasGraph, queryId: string): string {
  const query = group.nodes.flatMap((node) => node.members).find((node) => node.id === queryId)
  const source = query && querySource(query, group)
  return source?.shortClassName
    ? `${source.shortClassName}::${source.methodName ?? source.label}()`
    : source?.label ?? 'Source unavailable'
}

function Anchors({ id }: { id: string }) {
  return <>
    <Handle type="target" position={Position.Left} id={id} />
    <Handle type="source" position={Position.Right} id={id} />
    <Handle type="source" position={Position.Left} id={`${id}:left`} />
    <Handle type="target" position={Position.Right} id={`${id}:right`} />
  </>
}

function RuntimeCard({ id, data }: NodeProps<CardNode>) {
  const { group, graph, detail, collapsed, focused, selection } = data
  const primary = group.members[0]
  const database = primary.kind === 'sql'
  const overview = !database && (detail === 'overview' || collapsed)
  const rows = useMemo(() => methodRows(group), [group])
  const sections = useMemo(() => database ? querySections(group, graph) : [], [database, group, graph])
  const updateInternals = useUpdateNodeInternals()
  useEffect(() => { updateInternals(id) }, [id, overview, collapsed, detail, rows, sections, updateInternals])
  const select = (spanIds: string[], kind: 'method' | 'query') => data.onSelect(id, { nodeId: id, spanIds, kind })
  return <div className="node-card">
    <div className="node-header">
      <Anchors id="overview" />
      <span className="node-kind">{group.lane}</span>
      <strong className="node-title" title={primary.className ?? primary.label}>
        {database ? 'Database' : primary.shortClassName ?? primary.label}
      </strong>
      <span className="node-metric">
        {group.members.length} {database ? group.members.length === 1 ? 'query' : 'queries' : group.members.length === 1 ? 'call' : 'calls'} · {duration(groupDuration(group, graph))}
      </span>
      <button className="node-toggle nodrag nopan" type="button"
        aria-label={database ? 'Inspect database' : 'Inspect selected entity'}
        onClick={(event) => {
          event.stopPropagation()
          data.onInspect(id, !database && selection?.nodeId === id ? selection : null)
        }}>Inspect →</button>
      {!database && primary.kind !== 'request' && <button className="node-toggle nodrag nopan" type="button" aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${primary.shortClassName ?? primary.label}`}
        onClick={(event) => { event.stopPropagation(); data.onToggle() }}>
        {collapsed ? '▸' : '▾'} Methods
      </button>}
    </div>
    {!overview && !database && primary.kind !== 'request' && <div className="method-list">
      {rows.map((row) => {
        const internalParent = group.members.find((member) => member.id === row.members[0].span.parent_id)
        const query = selection?.kind === 'query' ? graph.nodes.flatMap((node) => node.members).find((member) => member.id === selection.spanIds[0]) : undefined
        const origin = query ? querySource(query, graph)?.id : undefined
        const active = row.members.some((member) => member.id === origin || selection?.spanIds.includes(member.id))
        const relevant = !focused || row.members.some((member) => focused.has(member.id))
        const total = row.members.reduce((sum, member) => sum + member.durationNs, 0)
        const self = row.members.reduce((sum, member) => sum + member.selfDurationNs, 0)
        return <div key={row.id}>
          {row.index === 0 && row.summary.labels.length > 1 && <div className="sequence-label">
            {data.sequenceNames[row.summary.key] ?? 'Repeated sequence'} ×{row.summary.count}
          </div>}
          <div className={`method-row ${active ? 'is-active' : ''} ${relevant ? '' : 'is-muted'}`}>
            <Anchors id={row.id} />
            <button className="method-select nodrag nopan" type="button" aria-pressed={active ?? false}
              title={internalParent ? `Called by ${internalParent.methodName}() · ${sourceLabel(row.members[0])}` : sourceLabel(row.members[0])}
              onClick={(event) => { event.stopPropagation(); select(row.members.map((member) => member.id), 'method') }}>
              <span className="method-name">{internalParent && <span className="internal-call" aria-label={`Called by ${internalParent.methodName}`}>↳ </span>}
                {row.label}{row.summary.labels.length === 1 && row.summary.count > 1 && <b> ×{row.summary.count}</b>}
              </span>
              <span className="method-timing">{duration(total)}</span>
              {detail === 'detail' && <small>{duration(self)} self · {row.members.length} calls{internalParent ? ` · ↓ from ${internalParent.methodName}()` : ''}</small>}
            </button>
          </div>
        </div>
      })}
    </div>}
    {database && <div className="query-list nodrag nopan nowheel">
      <div className="sequence-label">Queries · grouped by runtime source</div>
      {sections.map((section) => <section className="query-section" key={section.id}>
        <div className={`query-section-header ${section.queries.every((query) => selection?.spanIds.includes(query.id)) ? 'is-active' : ''}`}>
          <Handle className="query-group-handle" type="target" position={Position.Left} id={section.id} />
          <Handle className="query-group-handle" type="target" position={Position.Right} id={`${section.id}:right`} />
          <button className="query-group-select" type="button"
            aria-pressed={section.queries.every((query) => selection?.spanIds.includes(query.id))}
            onClick={(event) => { event.stopPropagation(); select(section.queries.map((query) => query.id), 'query') }}>
            <strong>{section.bootstrap ? 'Initialization' : `From ${shortSource(graph, section.queries[0].id)}`}</strong>
            <span>{section.queries.length} {section.queries.length === 1 ? 'query' : 'queries'} · {duration(section.durationNs)}</span>
          </button>
        </div>
        <div className="query-section-rows nowheel">{section.queries.map((query) => {
          const sql = query.label.replace(/^SQL\s+/, '')
          const operation = sql.match(/\b(SELECT|INSERT|UPDATE|DELETE|WITH|SET|BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|DROP)\b/i)?.[0].toUpperCase() ?? 'SQL'
          return <div key={query.id} className={`query-row ${selection?.spanIds.includes(query.id) ? 'is-active' : ''} ${focused && !focused.has(query.id) ? 'is-muted' : ''}`}>
            <button className="query-select" type="button" aria-pressed={selection?.spanIds.includes(query.id) ?? false}
              onClick={(event) => {
                event.stopPropagation(); select([query.id], 'query')
              }}
              onDoubleClick={(event) => {
                event.stopPropagation()
                data.onInspect(id, { nodeId: id, spanIds: [query.id], kind: 'query' })
              }}>
              <span><b>{operation}</b><span>{duration(query.durationNs)}</span></span>
              <span className="query-preview">{queryTarget(sql)}</span>
              <small>from {shortSource(graph, query.id)}</small>
            </button>
            <button className="query-inspect nodrag nopan" type="button"
              onClick={(event) => {
                event.stopPropagation()
                data.onInspect(id, { nodeId: id, spanIds: [query.id], kind: 'query' })
              }}>Inspect →</button>
          </div>
        })}</div>
      </section>)}
    </div>}
  </div>
}

const nodeTypes = { runtime: RuntimeCard }

export function TraceCanvas(props: TraceCanvasProps) {
  const { graph, selectedNodeId, selection, nodeStates, fieldStates, notes, groups, manualEdges, sequenceNames,
    savedViewport, onNodeSelect, onInspect, onPositionsChange, onObjectPositionChange, onToggleCollapse, onFieldsChange, onViewportChange } = props
  const detail: CardData['detail'] = (savedViewport?.zoom ?? 1) < 0.55 ? 'overview' : (savedViewport?.zoom ?? 1) > 1.25 ? 'detail' : 'normal'
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({})
  const fields = useMemo(() => architectureFields(graph, fieldStates), [graph, fieldStates])
  // Manual positions are overlaid below; structural layout only changes with the graph or explicit field edits.
  const structuralLayout = useMemo(() => initialLayout(graph, {}, fieldStates), [graph, fieldStates])
  const layout = useMemo(() => structuralLayout.map((box) => ({
    ...box,
    ...safePosition(nodeStates[box.id], box),
  })), [structuralLayout, nodeStates])
  const boxes = useMemo(() => layout.filter((box) => !nodeStates[box.id]?.hidden).map((box) => ({ ...box, ...sizes[box.id] })), [layout, sizes, nodeStates])
  const resizing = useRef<{ pointerId: number; clientX: number; field: ArchitectureField; boxes: Box[]; fields: ArchitectureField[] } | null>(null)
  const selectedSpans = useMemo(() => selection?.spanIds ?? graph.nodes.find((node) => node.id === selectedNodeId)?.members.map((member) => member.id), [selection, graph, selectedNodeId])
  const focused = useMemo(() => selectedSpans ? focusExecution(graph, selectedSpans) : null, [graph, selectedSpans])
  useEffect(() => {
    const missing = layout.filter((box) => !nodeStates[box.id]
      || nodeStates[box.id].x !== box.x || nodeStates[box.id].y !== box.y)
    if (missing.length) onPositionsChange(Object.fromEntries(missing.map((box) => [box.id, { x: box.x, y: box.y }])))
  }, [layout, nodeStates, onPositionsChange])
  const nodes = useMemo<Node[]>(() => [
    ...groups.map((group): Node => ({
      id: group.id, className: 'manual-group-node', position: { x: group.x, y: group.y },
      data: { label: <>{group.title}<button className="node-toggle nodrag nopan" type="button" onClick={(event) => { event.stopPropagation(); onInspect(group.id) }}>Inspect →</button></> }, style: { width: group.width, height: group.height }, zIndex: -2,
    })),
    ...layout.map((box): CardNode => {
      const group = graph.nodes.find((node) => node.id === box.id)!
      const relevant = !focused || group.members.some((member) => focused.has(member.id))
      return {
        id: box.id, type: 'runtime', position: { x: box.x, y: box.y },
        hidden: nodeStates[box.id]?.hidden, draggable: !nodeStates[box.id]?.pinned,
        selected: box.id === selectedNodeId, zIndex: 1,
        className: `runtime-node runtime-node--${group.members[0].kind} ${relevant ? '' : 'is-muted'} ${group.members.some((member) => member.hasError) ? 'runtime-node--error' : ''}`,
        style: { width: box.width },
        data: { group, graph, detail, collapsed: nodeStates[box.id]?.collapsed ?? false,
          focused: relevant ? focused : null, selection, sequenceNames, onSelect: onNodeSelect, onInspect, onToggle: () => onToggleCollapse(box.id) },
      }
    }),
    ...notes.map((note): Node => ({ id: note.id, className: 'note-node', position: { x: note.x, y: note.y },
      data: { label: <>{note.text}<button className="node-toggle nodrag nopan" type="button" onClick={(event) => { event.stopPropagation(); onInspect(note.id) }}>Inspect →</button></> }, draggable: !note.pinned, selected: note.id === selectedNodeId,
      style: { width: 220, minHeight: 100, whiteSpace: 'pre-wrap' } })),
  ], [groups, layout, graph, focused, nodeStates, selectedNodeId, detail, selection, sequenceNames, onNodeSelect, onInspect, onToggleCollapse, notes])
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState(nodes)
  useEffect(() => {
    setFlowNodes((current) => {
      const existing = new Map(current.map((node) => [node.id, node]))
      return nodes.map((node) => {
        const previous = existing.get(node.id)
        return previous ? {
          ...previous,
          ...node,
          position: previous.dragging ? previous.position : node.position,
          measured: previous.measured,
        } : node
      })
    })
  }, [nodes, setFlowNodes])
  useEffect(() => {
    const rendered = flowNodes.filter((node) => node.type === 'runtime')
    if (import.meta.env.DEV && rendered.length !== graph.nodes.length) {
      const ids = new Set(rendered.map((node) => node.id))
      console.warn('Runtime canvas node count changed unexpectedly', {
        expected: graph.nodes.length,
        rendered: rendered.length,
        missing: graph.nodes.filter((node) => !ids.has(node.id)).map((node) => node.id),
      })
    }
  }, [flowNodes, graph.nodes])
  const edges = useMemo<Edge[]>(() => {
    const visible = new Set(boxes.map((box) => box.id))
    const groupsById = new Map(graph.nodes.map((group) => [group.id, group]))
    const bundled = new Map<string, Edge>()
    for (const dependency of graph.edges) {
      if (!visible.has(dependency.source) || !visible.has(dependency.target)) continue
      let sourceHandle = detail === 'overview' || nodeStates[dependency.source]?.collapsed ? 'overview' : dependency.sourceHandle
      const targetGroup = groupsById.get(dependency.target)
      let targetHandle = targetGroup?.members[0]?.kind !== 'sql' && (detail === 'overview' || nodeStates[dependency.target]?.collapsed)
        ? 'overview' : dependency.targetHandle
      const source = boxes.find((box) => box.id === dependency.source)!
      const target = boxes.find((box) => box.id === dependency.target)!
      if (target.x + target.width <= source.x) { sourceHandle += ':left'; targetHandle += ':right' }
      else if (source.x + source.width > target.x) targetHandle += ':right'
      const id = JSON.stringify([dependency.source, sourceHandle, dependency.target, targetHandle])
      const active = !focused || dependency.calls.some((call) => focused.has(call.source) && focused.has(call.target))
      const previous = bundled.get(id)
      const count = Number(previous?.data?.count ?? 0) + dependency.calls.length
      const time = Number(previous?.data?.time ?? 0) + dependency.durationNs
      const highlighted = active || previous?.data?.active === true
      bundled.set(id, { id, source: dependency.source, target: dependency.target, sourceHandle, targetHandle, type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, color: focused && highlighted ? 'var(--edge-active)' : 'var(--edge)', width: 12, height: 12 },
        data: { count, time, active: highlighted },
        label: dependency.target === 'database:queries' && detail !== 'overview' ? `${count} ${count === 1 ? 'query' : 'queries'} · ${duration(time)}` : undefined,
        style: { opacity: highlighted ? 1 : 0.24, stroke: focused && highlighted ? 'var(--edge-active)' : 'var(--edge)', strokeWidth: focused && highlighted ? 1.8 : 1.2 },
      })
    }
    return [...bundled.values(), ...manualEdges.map((edge) => ({ ...edge, type: 'smoothstep',
      sourceHandle: graph.nodes.some((node) => node.id === edge.source) ? 'overview' : undefined,
      targetHandle: graph.nodes.some((node) => node.id === edge.target) ? 'overview' : undefined,
      style: { stroke: 'var(--edge)', strokeDasharray: '5 4' } }))]
  }, [boxes, graph, detail, nodeStates, focused, manualEdges])
  const viewport = savedViewport ?? { x: 0, y: 0, zoom: 1 }
  const resize = (field: ArchitectureField, width: number, currentBoxes = boxes, currentFields = fields) => {
    const next = resizeField(currentBoxes, currentFields, field.id, width)
    onFieldsChange(
      fieldState(next.fields),
      Object.fromEntries(next.boxes.map((box) => [box.id, { x: box.x, y: box.y }])),
    )
  }
  return <div className={`trace-canvas detail-${detail}`}>
    <div className="architecture-fields" aria-hidden="true">
      {fields.map((field) => <div key={field.id} className="architecture-field" style={{ left: viewport.x + field.x * viewport.zoom, width: field.width * viewport.zoom }} />)}
    </div>
    <div className="architecture-field-controls">
      {fields.map((field) => <div key={field.id} className="field-controls" style={{ left: viewport.x + field.x * viewport.zoom, width: field.width * viewport.zoom }}>
        <span className="field-label">{field.lane}</span>
        <div className="field-resizer" role="separator" tabIndex={0} aria-orientation="vertical"
          aria-label={`Resize ${field.lane.toUpperCase()} field`} aria-valuenow={Math.round(field.width)} aria-valuemin={MIN_FIELD_WIDTH}
          title="Drag to resize field · arrow keys to adjust"
          onPointerDown={(event) => {
            event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
            resizing.current = { pointerId: event.pointerId, clientX: event.clientX, field, boxes: layout.map((box) => ({ ...box, ...sizes[box.id] })), fields }
          }}
          onPointerMove={(event) => {
            const start = resizing.current
            if (start && start.pointerId === event.pointerId) resize(start.field, start.field.width + (event.clientX - start.clientX) / viewport.zoom, start.boxes, start.fields)
          }}
          onPointerUp={() => { resizing.current = null }} onPointerCancel={() => { resizing.current = null }}
          onKeyDown={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) {
              event.preventDefault()
              resize(field, event.key === 'Home' ? MIN_FIELD_WIDTH : field.width + (event.key === 'ArrowLeft' ? -24 : 24), layout.map((box) => ({ ...box, ...sizes[box.id] })))
            }
          }} />
      </div>)}
    </div>
    <div className="canvas-legend">{detail === 'overview' ? 'Architecture' : detail === 'detail' ? 'Runtime · total / self' : 'Architecture + runtime'}<span>Stable architecture fields</span></div>
    <ReactFlow nodes={flowNodes} edges={edges} nodeTypes={nodeTypes}
      fitView={savedViewport === null} viewport={savedViewport ?? undefined} defaultViewport={savedViewport ?? undefined} fitViewOptions={{ padding: 0.15 }}
      minZoom={0.15} maxZoom={2.5} nodeDragThreshold={0} nodesConnectable={false} deleteKeyCode={null}
      onNodesChange={(changes) => {
        const measured: typeof sizes = {}
        const safeChanges = changes.map((change) => {
          if (change.type === 'position' && change.position) {
            const current = flowNodes.find((node) => node.id === change.id)
            const fallback = current?.position ?? { x: 0, y: 0 }
            const position = safePosition(change.position, fallback)
            if (import.meta.env.DEV && (position.x !== change.position.x || position.y !== change.position.y)) {
              console.warn('Ignored invalid canvas node position', { nodeId: change.id, previous: fallback, next: change.position })
            }
            return { ...change, position }
          }
          if (change.type === 'dimensions' && change.dimensions) {
            const previous = sizes[change.id]
            if (previous?.width !== change.dimensions.width || previous?.height !== change.dimensions.height) {
              measured[change.id] = change.dimensions
            }
          }
          return change
        })
        onFlowNodesChange(safeChanges)
        if (Object.keys(measured).length) setSizes((current) => ({ ...current, ...measured }))
      }}
      onNodeDragStop={(_, node) => {
        if (node.id.startsWith('note:') || node.id.startsWith('group:')) {
          const position = safePosition(node.position, node.position)
          onObjectPositionChange(node.id, position.x, position.y)
          return
        }
        const box = boxes.find((item) => item.id === node.id)
        const field = fields.find((item) => item.lane === box?.lane)
        if (box && field) onPositionsChange({ [node.id]: clampPositionToField(box, field, node.position) })
      }}
      onViewportChange={onViewportChange}
      onNodeClick={(_, node) => onNodeSelect(node.id)}
      onPaneClick={() => onNodeSelect(null)}>
      <Background color="var(--canvas-dot)" gap={24} size={1} />
      <Controls />
    </ReactFlow>
  </div>
}
