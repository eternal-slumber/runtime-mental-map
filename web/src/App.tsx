import { useEffect, useRef, useState } from 'react'
import './App.css'
import { TraceCanvas } from './TraceCanvas'
import { groupGraphByClass, traceToGraph, type TraceView } from './traceGraph'

type TraceSummary = {
  trace_id: string
  service_name: string
  status: string
  name: string
  duration_ns: number
  span_count: number
  outcome?: string
  http_status?: number
}

function formatDuration(durationNs: number): string {
  if (durationNs === 0) {
    return '—'
  }

  return `${(durationNs / 1_000_000).toFixed(1)} ms`
}

function App() {
  const [traces, setTraces] = useState<TraceSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [selectedTrace, setSelectedTrace] = useState<TraceView | null>(null)
  const [traceError, setTraceError] = useState<string | null>(null)
  const [traceLoading, setTraceLoading] = useState(false)
  const [showServiceQueries, setShowServiceQueries] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const traceSection = useRef<HTMLElement>(null)

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
      } catch (error) {
        if (error instanceof Error && error.name !== 'AbortError') {
          setError(error.message)
        }
      } finally {
        setLoading(false)
      }
    }

    void loadTraces()

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

  const selectedGraph = selectedTrace === null
    ? null
    : traceToGraph(selectedTrace, !showServiceQueries)
  const displayGraph = selectedGraph === null
    ? null
    : groupGraphByClass(selectedGraph)
  const selectedNode = displayGraph?.nodes.find(
    (node) => node.id === selectedNodeId,
  ) ?? null
  const primaryNode = selectedNode?.members[0] ?? null
  const selectedChildren = selectedNode?.members.flatMap(
    (node) => node.span.children.filter(
      (child) => child.class !== primaryNode?.className,
    ),
  ) ?? []

  useEffect(() => {
    if (selectedTrace !== null) {
      traceSection.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [selectedTrace])

  return (
    <main className="app">
      <header className="header">
        <p className="eyebrow">Runtime Mental Map</p>
        <h1>Traces</h1>
      </header>

      {loading && <p className="message">Loading traces…</p>}

      {error !== null && (
        <p className="message error">
          Could not load traces: {error}
        </p>
      )}

      {!loading && error === null && traces.length === 0 && (
        <p className="message">
          No traces yet. Make a request to FoodTracker.
        </p>
      )}

      <ul className="trace-list">
        {traces.map((trace) => (
          <li className="trace-card" key={trace.trace_id}>
            <div>
              <span className="service">{trace.service_name}</span>
              <h2>{trace.name || 'Waiting for root span'}</h2>
              <p className="trace-id">{trace.trace_id}</p>
            </div>

            <dl className="trace-meta">
              <div>
                <dt>Status</dt>
                <dd>{trace.http_status ?? trace.status}</dd>
              </div>

              <div>
                <dt>Duration</dt>
                <dd>{formatDuration(trace.duration_ns)}</dd>
              </div>

              <div>
                <dt>Spans</dt>
                <dd>{trace.span_count}</dd>
              </div>
            </dl>

            <button
              className="counter"
              type="button"
              aria-pressed={selectedTraceId === trace.trace_id}
              onClick={() => {
                setSelectedNodeId(null)
                setSelectedTraceId(trace.trace_id)
              }}
            >
              {selectedTraceId === trace.trace_id ? 'Selected' : 'Open trace'}
            </button>
          </li>
        ))}
      </ul>

      {traceLoading && <p className="message">Loading trace…</p>}

      {traceError !== null && (
        <p className="message error">
          Could not load trace: {traceError}
        </p>
      )}

      {selectedTrace !== null && selectedGraph !== null && displayGraph !== null && (
        <section ref={traceSection}>
          <h2>Trace {selectedTrace.trace_id}</h2>
          <p>
            {selectedGraph.nodes.length} spans · {displayGraph.nodes.length} nodes ·{' '}
            {displayGraph.edges.length} edges
          </p>
          <label>
            <input
              type="checkbox"
              checked={showServiceQueries}
              onChange={(event) => setShowServiceQueries(event.target.checked)}
            />{' '}
            Show service queries
          </label>
          <div className="trace-workspace">
            <TraceCanvas
              graph={displayGraph}
              selectedNodeId={selectedNodeId}
              onNodeSelect={setSelectedNodeId}
            />

            <aside className="trace-inspector" aria-live="polite">
              {selectedNode === null || primaryNode === null ? (
                <p>Select a node to inspect it.</p>
              ) : (
                <>
                  <h2>{primaryNode.shortClassName ?? primaryNode.label}</h2>

                  <dl>
                    <dt>Layer</dt>
                    <dd>{selectedNode.lane}</dd>
                    <dt>Kind</dt>
                    <dd>{selectedNode.members.length > 1 ? 'class group' : primaryNode.kind}</dd>
                    <dt>Spans</dt>
                    <dd>{selectedNode.members.length}</dd>
                    <dt>Class</dt>
                    <dd>{primaryNode.className ?? '—'}</dd>
                    <dt>Trace</dt>
                    <dd>{primaryNode.span.trace_id}</dd>
                  </dl>

                  <h2>{primaryNode.className === null ? 'Span' : 'Methods'}</h2>
                  <ul>
                    {selectedNode.members.map((node) => (
                      <li key={node.id}>
                        {node.methodName === null ? node.label : `${node.methodName}()`}
                        {' — '}{formatDuration(node.durationNs)} total,{' '}
                        {formatDuration(node.selfDurationNs)} self,{' '}
                        {node.outcome ?? 'unknown'}
                        {node.span.error_type !== undefined && (
                          <> — {node.span.error_type}: {node.span.error_message}</>
                        )}
                      </li>
                    ))}
                  </ul>

                  <h2>Children</h2>
                  {selectedChildren.length === 0 ? (
                    <p>None</p>
                  ) : (
                    <ul>
                      {selectedChildren.map((child) => (
                        <li key={child.span_id}>
                          {child.name} — {formatDuration(child.duration_ns)}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </aside>
          </div>
          <details>
            <summary>Raw trace JSON</summary>
            <pre>{JSON.stringify(selectedTrace, null, 2)}</pre>
          </details>
        </section>
      )}
    </main>
  )
}

export default App
