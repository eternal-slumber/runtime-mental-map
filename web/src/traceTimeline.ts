export type TimelineTrace = {
  trace_id: string
  service_name: string
  flow_id?: string
  parent_trace_id?: string
  started_at_unix_us: number
}

export type TimelineNode<T extends TimelineTrace> = {
  trace: T
  children: TimelineNode<T>[]
}

export type TraceFlow<T extends TimelineTrace> = {
  id: string
  correlated: boolean
  serviceName: string
  startedAtUnixUS: number
  requestCount: number
  nodes: TimelineNode<T>[]
}

const byStart = <T extends TimelineTrace>(a: TimelineNode<T>, b: TimelineNode<T>) =>
  a.trace.started_at_unix_us - b.trace.started_at_unix_us

function createsCycle<T extends TimelineTrace>(trace: T, traces: Map<string, T>): boolean {
  const seen = new Set([trace.trace_id])
  let parentID = trace.parent_trace_id

  while (parentID) {
    if (seen.has(parentID)) return true
    seen.add(parentID)
    parentID = traces.get(parentID)?.parent_trace_id
  }

  return false
}

export function buildTraceFlows<T extends TimelineTrace>(traces: T[]): TraceFlow<T>[] {
  const groups = new Map<string, T[]>()

  for (const trace of traces) {
    const id = trace.flow_id ?? `trace:${trace.trace_id}`
    groups.set(id, [...(groups.get(id) ?? []), trace])
  }

  return [...groups.entries()].map(([id, items]) => {
    const tracesByID = new Map(items.map((trace) => [trace.trace_id, trace]))
    const nodesByID = new Map(items.map((trace) => [
      trace.trace_id,
      { trace, children: [] } as TimelineNode<T>,
    ]))
    const roots: TimelineNode<T>[] = []

    for (const node of nodesByID.values()) {
      const parent = node.trace.parent_trace_id
        ? nodesByID.get(node.trace.parent_trace_id)
        : undefined

      if (parent && !createsCycle(node.trace, tracesByID)) parent.children.push(node)
      else roots.push(node)
    }

    const sortTree = (nodes: TimelineNode<T>[]) => {
      nodes.sort(byStart)
      for (const node of nodes) sortTree(node.children)
    }
    sortTree(roots)

    return {
      id,
      correlated: !id.startsWith('trace:'),
      serviceName: items[0]?.service_name ?? 'unknown',
      startedAtUnixUS: Math.min(...items.map((trace) => trace.started_at_unix_us)),
      requestCount: items.length,
      nodes: roots,
    }
  }).sort((a, b) => b.startedAtUnixUS - a.startedAtUnixUS)
}
