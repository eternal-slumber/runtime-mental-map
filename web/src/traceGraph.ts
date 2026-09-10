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
  sequence: number
  siblingIndex: number
  parentContextKey: string | null
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
  edges: RuntimeDependency[]
  executionEdges: CanvasEdge[]
}

export type RuntimeDependency = CanvasEdge & {
  sourceHandle: string
  targetHandle: string
  calls: CanvasEdge[]
  durationNs: number
}

export type QuerySection = {
  id: string
  source: CanvasNode | undefined
  bootstrap: boolean
  category: 'bootstrap' | 'request' | 'application'
  queries: CanvasNode[]
  durationNs: number
}

export type GroupedMemberSummary = {
  key: string
  labels: string[]
  count: number
  totalDurationNs: number
  totalSelfDurationNs: number
  errorCount: number
  members: CanvasNode[]
}

export function groupGraphByClass(graph: CanvasGraph): GroupedCanvasGraph {
  const groups = new Map<string, GroupedCanvasNode>()
  const nodeGroup = new Map<string, string>()
  const nodes: GroupedCanvasNode[] = []

  for (const node of graph.nodes) {
    const groupId = node.kind === 'sql'
      ? 'database:queries'
      : node.kind === 'method' && node.className !== null
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

  const anchors = new Map(nodes.flatMap((group) => methodRows(group).flatMap(
    (row) => row.members.map((member) => [member.id, row.id] as const),
  )))
  const members = new Map(graph.nodes.map((node) => [node.id, node]))
  const database = groups.get('database:queries')
  const queryTargets = new Map(database
    ? querySections(database, { nodes, edges: [], executionEdges: graph.edges }).flatMap(
      (section) => section.queries.map((query) => [query.id, section.id] as const),
    ) : [])
  const dependencies = new Map<string, RuntimeDependency>()
  for (const edge of graph.edges) {
    const source = nodeGroup.get(edge.source)
    const target = nodeGroup.get(edge.target)

    if (source === undefined || target === undefined || source === target) {
      continue
    }

    const sourceHandle = members.get(edge.source)?.kind === 'method' ? anchors.get(edge.source) ?? 'overview' : 'overview'
    const targetHandle = members.get(edge.target)?.kind === 'sql'
      ? queryTargets.get(edge.target) ?? 'overview' : anchors.get(edge.target) ?? 'overview'
    const id = JSON.stringify([source, sourceHandle, target, targetHandle])
    const dependency = dependencies.get(id) ?? {
      id, source, target, sourceHandle, targetHandle, calls: [], durationNs: 0,
    }
    dependency.calls.push(edge)
    dependency.durationNs += members.get(edge.target)?.durationNs ?? 0
    dependencies.set(id, dependency)
  }

  return { nodes, edges: [...dependencies.values()], executionEdges: graph.edges }
}

export function summarizeGroupMembers(
  group: GroupedCanvasNode,
): GroupedMemberSummary[] {
  const summaries: GroupedMemberSummary[] = []
  const nodes = group.members

  for (let index = 0; index < nodes.length;) {
    let scalarCount = 1
    while (
      index + scalarCount < nodes.length
      && sameSiblingCall(nodes[index + scalarCount - 1], nodes[index + scalarCount])
    ) {
      scalarCount += 1
    }

    if (scalarCount > 1) {
      const members = nodes.slice(index, index + scalarCount)
      summaries.push(summary(members, [methodLabel(nodes[index])], scalarCount))
      index += scalarCount
      continue
    }

    let patternLength = 0
    let repetitions = 1
    for (let candidate = 2; candidate <= (nodes.length - index) / 2; candidate += 1) {
      let count = 1
      while (
        index + (count + 1) * candidate <= nodes.length
        && sameContextSequence(
          nodes.slice(index, index + candidate),
          nodes.slice(index + count * candidate, index + (count + 1) * candidate),
        )
      ) {
        count += 1
      }
      if (count > 1) {
        patternLength = candidate
        repetitions = count
        break
      }
    }

    if (patternLength > 0) {
      const pattern = nodes.slice(index, index + patternLength)
      const members = nodes.slice(index, index + patternLength * repetitions)
      summaries.push(summary(members, pattern.map(methodLabel), repetitions))
      index += members.length
      continue
    }

    summaries.push(summary([nodes[index]], [methodLabel(nodes[index])], 1))
    index += 1
  }

  return summaries
}

function sameSiblingCall(previous: CanvasNode, next: CanvasNode): boolean {
  return methodLabel(previous) === methodLabel(next)
    && previous.span.parent_id === next.span.parent_id
    && previous.siblingIndex + 1 === next.siblingIndex
}

function sameContextSequence(left: CanvasNode[], right: CanvasNode[]): boolean {
  return left.every((node, index) => {
    const candidate = right[index]
    return methodLabel(node) === methodLabel(candidate)
      && node.parentContextKey === candidate.parentContextKey
  })
}

function summary(
  nodes: CanvasNode[],
  labels: string[],
  count: number,
): GroupedMemberSummary {
  return {
    key: nodes[0].id,
    members: nodes,
    labels,
    count,
    totalDurationNs: nodes.reduce((total, node) => total + node.durationNs, 0),
    totalSelfDurationNs: nodes.reduce((total, node) => total + node.selfDurationNs, 0),
    errorCount: nodes.filter((node) => node.hasError).length,
  }
}

function methodLabel(node: CanvasNode): string {
  return node.methodName === null ? node.label : `${node.methodName}()`
}

export function methodRows(group: GroupedCanvasNode) {
  return summarizeGroupMembers(group).flatMap((summary) => summary.labels.map((label, index) => ({
    id: `method:${summary.key}:${index}`,
    label,
    summary,
    index,
    members: summary.members.filter((_, memberIndex) => memberIndex % summary.labels.length === index),
  })))
}

// Inclusive class time counts entry spans once, excluding nested calls in that class.
export function groupDuration(group: GroupedCanvasNode, graph?: GroupedCanvasGraph): number {
  const ids = new Set(group.members.map((node) => node.id))
  const members = new Map((graph?.nodes.flatMap((node) => node.members) ?? group.members).map((node) => [node.id, node]))
  return group.members.reduce((total, node) => {
    let parent = node.span.parent_id
    const seen = new Set<string>()
    while (parent !== null && !seen.has(parent)) {
      if (ids.has(parent)) return total
      seen.add(parent)
      parent = members.get(parent)?.span.parent_id ?? null
    }
    return total + node.durationNs
  }, 0)
}

export function querySource(query: CanvasNode, graph: GroupedCanvasGraph): CanvasNode | undefined {
  const members = new Map(graph.nodes.flatMap((node) => node.members).map((node) => [node.id, node]))
  let parent = query.span.parent_id
  const seen = new Set<string>()
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent)
    const source = members.get(parent)
    if (!source || source.kind === 'method' || source.kind === 'request') return source
    parent = source.span.parent_id
  }
}

const executionOrder = (left: CanvasNode, right: CanvasNode) =>
  left.span.started_at_unix_us - right.span.started_at_unix_us || left.sequence - right.sequence

export function querySections(group: GroupedCanvasNode, graph: GroupedCanvasGraph): QuerySection[] {
  const members = graph.nodes.flatMap((node) => node.members)
  const firstBusiness = members
    .filter((node) => node.kind === 'method' && ['controller', 'application', 'domain', 'repository'].includes(node.lane))
    .sort(executionOrder)[0]
  const sections: (QuerySection & { context: string })[] = []

  for (const query of [...group.members].sort(executionOrder)) {
    const source = querySource(query, graph)
    const bootstrap = source?.kind === 'request' && firstBusiness !== undefined && executionOrder(query, firstBusiness) < 0
    const category = bootstrap ? 'bootstrap' : source?.kind === 'request' ? 'request' : 'application'
    const context = `${category}:${source?.id ?? 'unknown'}`
    const previous = sections.at(-1)
    if (previous?.context === context) {
      previous.queries.push(query)
      previous.durationNs += query.durationNs
    } else {
      sections.push({ id: `db-group:${bootstrap ? 'initialization' : source?.id ?? 'unknown'}:${query.id}`, context, source, bootstrap, category, queries: [query], durationNs: query.durationNs })
    }
  }

  const order = { bootstrap: 0, request: 1, application: 2 }
  return sections.sort((left, right) => order[left.category] - order[right.category])
    .map(({ id, source, bootstrap, category, queries, durationNs }) => ({ id, source, bootstrap, category, queries, durationNs }))
}

export function sourceLabel(node: CanvasNode | undefined): string {
  return node ? node.className ? `${node.className}::${node.methodName ?? node.label}()` : node.label : 'Source unavailable (missing parent)'
}

export function focusExecution(graph: GroupedCanvasGraph, selectedIds: string[]): Set<string> {
  const focused = new Set(selectedIds)
  // Traverse ancestors and descendants separately; ancestors' other children are unrelated.
  for (const direction of ['up', 'down']) {
    const visited = new Set(selectedIds)
    const queue = [...selectedIds]
    const neighbors = new Map<string, string[]>()
    for (const edge of graph.executionEdges) {
      const from = direction === 'up' ? edge.target : edge.source
      const to = direction === 'up' ? edge.source : edge.target
      neighbors.set(from, [...(neighbors.get(from) ?? []), to])
    }
    for (let index = 0; index < queue.length; index++) {
      for (const id of neighbors.get(queue[index]) ?? []) {
        if (!visited.has(id)) { visited.add(id); focused.add(id); queue.push(id) }
      }
    }
  }
  return focused
}

export function traceToGraph(
  trace: TraceView,
  hideServiceSQL = false,
): CanvasGraph {
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []

  function visit(
    span: SpanNode,
    parent: SpanNode | null,
    depth: number,
    siblingIndex: number,
  ): void {
    if (hideServiceSQL && isServiceSQL(span)) {
      span.children.forEach((child, index) => visit(
        child,
        parent,
        depth,
        index,
      ))
      return
    }

    nodes.push({
      id: span.span_id,
      sequence: nodes.length,
      siblingIndex,
      parentContextKey: parent === null ? null : spanContextKey(parent),
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

    if (parent !== null) {
      edges.push({
        id: `${parent.span_id}->${span.span_id}`,
        source: parent.span_id,
        target: span.span_id,
      })
    }

    span.children.forEach((child, index) => visit(child, span, depth + 1, index))
  }

  if (trace.root !== null) {
    visit(trace.root, null, 0, 0)
  }
  trace.orphans.forEach((orphan, index) => visit(orphan, null, 0, index))

  return { nodes, edges }
}

function spanContextKey(span: SpanNode): string {
  return `${span.kind}:${span.class ?? ''}:${span.method ?? span.name}`
}

function isServiceSQL(span: SpanNode): boolean {
  return span.kind === 'sql' && /^SQL\s+SET\b/i.test(span.name)
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
