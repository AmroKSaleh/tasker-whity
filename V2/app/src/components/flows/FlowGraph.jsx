import { useMemo } from 'react'
import { ReactFlow, Background, Controls, Handle, Position, MarkerType } from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import '@xyflow/react/dist/style.css'
import { inputSourceIds } from '../../lib/flowGraph'

// Read-only, single-flow node graph (TDE-189). Unlike BlueprintView (project-wide,
// section-column layout), this lays one flow out left→right by dependency depth
// (dagre), which reads naturally for a single flow. Built for node interaction later.

const NODE_W = 210
const NODE_H = 78
const ACCENT = '#D97757'

function statusColor(status) {
  if (status === 'done') return '#4ade80'
  if (status === 'in_progress') return ACCENT
  return 'var(--color-line)'
}

function FlowTaskNode({ data }) {
  const { task, prefix, step, onTaskClick } = data
  const color = statusColor(task.status)
  return (
    <div
      onClick={() => onTaskClick?.(task.id)}
      style={{
        width: NODE_W, minHeight: NODE_H, background: 'var(--color-paper)',
        border: `1.5px solid ${color}`, borderRadius: 8, padding: '9px 11px',
        boxSizing: 'border-box', fontFamily: 'inherit',
        cursor: onTaskClick ? 'pointer' : 'default',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--color-mute-2)', letterSpacing: '0.06em', fontWeight: 700 }}>
          STEP {step}{prefix && task.short_id != null ? ` · ${prefix}-${task.short_id}` : ''}
        </span>
      </div>
      <div style={{
        fontSize: 12.5, fontWeight: 600, color: 'var(--color-ink)', lineHeight: 1.35,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {task.text}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />
    </div>
  )
}

const nodeTypes = { flowTask: FlowTaskNode }

function buildLayout(steps, prefix, onTaskClick) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 90 })
  g.setDefaultEdgeLabel(() => ({}))

  const stepByTaskId = new Map(steps.map(s => [s.task.id, s.step]))
  steps.forEach(s => g.setNode(s.task.id, { width: NODE_W, height: NODE_H }))

  const edges = []
  steps.forEach(s => {
    inputSourceIds(s.task.input).forEach(src => {
      if (!stepByTaskId.has(src)) return
      g.setEdge(src, s.task.id)
      edges.push({
        id: `${src}->${s.task.id}`,
        source: src,
        target: s.task.id,
        type: 'smoothstep',
        style: { stroke: ACCENT, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: ACCENT },
      })
    })
  })

  dagre.layout(g)

  // Dagre doesn't guarantee insertion-order vertical placement within a rank.
  // Group siblings by x position and re-sort by step number so lower step = higher on screen.
  const rawPos = new Map(steps.map(s => [s.task.id, g.node(s.task.id)]))
  const byRank = new Map()
  steps.forEach(s => {
    const key = Math.round(rawPos.get(s.task.id).x)
    if (!byRank.has(key)) byRank.set(key, [])
    byRank.get(key).push(s)
  })
  const adjustedY = new Map()
  byRank.forEach(rankSteps => {
    const sorted = [...rankSteps].sort((a, b) => a.step - b.step)
    const ys = sorted.map(s => rawPos.get(s.task.id).y).sort((a, b) => a - b)
    sorted.forEach((s, i) => adjustedY.set(s.task.id, ys[i] ?? rawPos.get(s.task.id).y))
  })

  const nodes = steps.map(s => {
    const raw = rawPos.get(s.task.id)
    return {
      id: s.task.id,
      type: 'flowTask',
      position: { x: raw.x - NODE_W / 2, y: (adjustedY.get(s.task.id) ?? raw.y) - NODE_H / 2 },
      data: { task: s.task, step: s.step, prefix, onTaskClick },
      draggable: false,
    }
  })

  return { nodes, edges }
}

export default function FlowGraph({ steps, prefix, onTaskClick }) {
  const { nodes, edges } = useMemo(() => buildLayout(steps, prefix, onTaskClick), [steps, prefix, onTaskClick])
  return (
    <div style={{ width: '100%', height: '100%', background: 'var(--color-surf-2)' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnScroll
        zoomOnScroll
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={1.5}
      >
        <Background color="var(--color-line-2)" gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
