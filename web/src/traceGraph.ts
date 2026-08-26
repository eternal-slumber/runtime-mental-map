export type SpanNode = {
  protocol_version: number
  service_name: string
  trace_id: string
  span_id: string
  parent_id: string | null
  kind: 'request' | 'method' | 'sql'
  runtime: string
  framework: string
  layer: string | null
  name: string
  class: string | null
  method: string | null
  started_at_unix_us: number
  duration_ns: number
  outcome?: string
  http_status?: number
  error_type?: string
  error_message?: string
  error_file?: string
  error_line?: number
  children: SpanNode[]
}

export type TraceView = {
  trace_id: string
  status: string
  span_count: number
  root: SpanNode | null
  orphans: SpanNode[]
  missing_parents: string[]
  errors: string[]
}

export type SemanticLane =
  | 'request'
  | 'controller'
  | 'application'
  | 'domain'
  | 'repository'
  | 'database'
  | 'external'
  | 'unknown'

export type CanvasNode = {
  id: string
  depth: number
  kind: SpanNode['kind']
  lane: SemanticLane
  label: string
  className: string | null
  shortClassName: string | null
  methodName: string | null
  durationNs: number
  selfDurationNs: number
  outcome?: string
  hasError: boolean
  span: SpanNode
}

export type CanvasEdge = {
  id: string
  source: string
  target: string
}

export type CanvasGraph = {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export type GroupedCanvasNode = {
  id: string
  lane: SemanticLane
  members: CanvasNode[]
}

export type GroupedCanvasGraph = {
  nodes: GroupedCanvasNode[]
  edges: CanvasEdge[]
}

export type PositionedCanvasNode = GroupedCanvasNode & {
  position: {
    x: number
    y: number
  }
}

export type LaneColumn = {
  lane: SemanticLane
  x: number
}

export type SemanticLayout = {
  nodes: PositionedCanvasNode[]
  columns: LaneColumn[]
}

const laneOrder: SemanticLane[] = [
  'request',
  'controller',
  'application',
  'domain',
  'repository',
  'database',
  'external',
  'unknown',
]

export function groupGraphByClass(graph: CanvasGraph): GroupedCanvasGraph {
  const groups = new Map<string, GroupedCanvasNode>()
  const nodeGroup = new Map<string, string>()
  const nodes: GroupedCanvasNode[] = []

  for (const node of graph.nodes) {
    const groupId = node.kind === 'method' && node.className !== null
      ? `class:${node.className}`
      : node.id
    let group = groups.get(groupId)

    if (group === undefined) {
      group = { id: groupId, lane: node.lane, members: [] }
      groups.set(groupId, group)
      nodes.push(group)
    }

    group.members.push(node)
    nodeGroup.set(node.id, groupId)
  }

  const seenEdges = new Set<string>()
  const edges: CanvasEdge[] = []
  for (const edge of graph.edges) {
    const source = nodeGroup.get(edge.source)
    const target = nodeGroup.get(edge.target)

    if (source === undefined || target === undefined || source === target) {
      continue
    }

    const id = `${source}->${target}`
    if (!seenEdges.has(id)) {
      seenEdges.add(id)
      edges.push({ id, source, target })
    }
  }

  return { nodes, edges }
}

export function layoutGraphByLane(graph: GroupedCanvasGraph): SemanticLayout {
  const activeLanes = new Set(graph.nodes.map((node) => node.lane))
  const columns = laneOrder
    .filter((lane) => activeLanes.has(lane))
    .map((lane, index) => ({ lane, x: index * 300 }))
  const columnX = new Map(columns.map((column) => [column.lane, column.x]))
  const nextY = new Map<SemanticLane, number>()

  const nodes = graph.nodes.map((node) => {
    const y = nextY.get(node.lane) ?? 90
    // ponytail: estimated card height; replace with ELK when cards become dynamic.
    nextY.set(node.lane, y + Math.max(120, 70 + node.members.length * 24))

    return {
      ...node,
      position: {
        x: columnX.get(node.lane) ?? 0,
        y,
      },
    }
  })

  return { nodes, columns }
}

export function traceToGraph(
  trace: TraceView,
  hideServiceSQL = false,
): CanvasGraph {
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []

  function visit(
    span: SpanNode,
    parentId: string | null,
    depth: number,
  ): void {
    if (hideServiceSQL && isServiceSQL(span)) {
      span.children.forEach((child) => visit(child, parentId, depth))
      return
    }

    nodes.push({
      id: span.span_id,
      depth,
      kind: span.kind,
      lane: semanticLane(span),
      label: span.name,
      className: span.class,
      shortClassName: shortClassName(span.class),
      methodName: span.method,
      durationNs: span.duration_ns,
      selfDurationNs: selfDuration(span),
      outcome: span.outcome,
      hasError: span.outcome === 'exception' || span.error_type !== undefined,
      span,
    })

    if (parentId !== null) {
      edges.push({
        id: `${parentId}->${span.span_id}`,
        source: parentId,
        target: span.span_id,
      })
    }

    span.children.forEach((child) => visit(child, span.span_id, depth + 1))
  }

  if (trace.root !== null) {
    visit(trace.root, null, 0)
  }
  trace.orphans.forEach((orphan) => visit(orphan, null, 0))

  return { nodes, edges }
}

function isServiceSQL(span: SpanNode): boolean {
  return span.kind === 'sql' && span.name.startsWith('SQL SET ')
}

function semanticLane(span: SpanNode): SemanticLane {
  if (span.kind === 'request') {
    return 'request'
  }
  if (span.kind === 'sql') {
    return 'database'
  }

  switch (span.layer) {
    case 'controller':
    case 'application':
    case 'domain':
    case 'repository':
    case 'database':
    case 'external':
      return span.layer
    default:
      return 'unknown'
  }
}

function shortClassName(className: string | null): string | null {
  return className?.split('\\').at(-1) ?? null
}

function selfDuration(span: SpanNode): number {
  const childrenDuration = span.children.reduce(
    (total, child) => total + child.duration_ns,
    0,
  )

  return Math.max(0, span.duration_ns - childrenDuration)
}
