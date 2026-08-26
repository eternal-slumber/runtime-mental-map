import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react'
import { useMemo } from 'react'
import { layoutGraphByLane, type GroupedCanvasGraph } from './traceGraph'

type TraceCanvasProps = {
  graph: GroupedCanvasGraph
  selectedNodeId: string | null
  onNodeSelect: (nodeId: string | null) => void
}

function formatDuration(durationNs: number): string {
  return `${(durationNs / 1_000_000).toFixed(2)} ms`
}

export function TraceCanvas({
  graph,
  selectedNodeId,
  onNodeSelect,
}: TraceCanvasProps) {
  const layout = useMemo(() => layoutGraphByLane(graph), [graph])

  const nodes = useMemo<Node[]>(
    () => [
      ...layout.columns.map((column) => ({
        id: `lane:${column.lane}`,
        position: { x: column.x, y: 0 },
        data: { label: column.lane.toUpperCase() },
        draggable: false,
        selectable: false,
        focusable: false,
        style: {
          width: 250,
          color: 'var(--text-h)',
          background: 'var(--code-bg)',
          borderColor: 'var(--border)',
          fontWeight: 700,
        },
      })),
      ...layout.nodes.map((group) => {
        const primary = group.members[0]

        return {
          id: group.id,
          position: group.position,
          selected: group.id === selectedNodeId,
          data: {
            label: (
              <div>
                <strong>{primary.shortClassName ?? primary.kind.toUpperCase()}</strong>
                {group.members.map((node) => (
                  <div key={node.id}>
                    {node.methodName === null ? node.label : `${node.methodName}()`}
                    {' · '}{formatDuration(node.durationNs)}
                  </div>
                ))}
              </div>
            ),
          },
          style: {
            width: 250,
            borderColor: group.members.some((node) => node.hasError)
              ? '#dc2626'
              : undefined,
          },
        }
      }),
    ],
    [layout, selectedNodeId],
  )

  const edges = useMemo<Edge[]>(
    () => graph.edges.map((edge) => ({
      ...edge,
      type: 'smoothstep',
    })),
    [graph.edges],
  )

  return (
    <div className="trace-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesConnectable={false}
        onNodeClick={(_, node) => {
          if (!node.id.startsWith('lane:')) {
            onNodeSelect(node.id)
          }
        }}
        onPaneClick={() => onNodeSelect(null)}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}
