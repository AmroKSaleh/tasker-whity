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
  const { task, prefix, step } = data
  const color = statusColor(task.status)
  return (
    <div style={{
      width: NODE_W, minHeight: NODE_H, background: 'var(--color-paper)',
      border: `1.5px solid ${color}`, borderRadius: 8, padding: '9px 11px',
      boxSizing: 'border-box', fontFamily: 'inherit',
    }}>
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

function buildLayout(steps, prefix) {
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

  const nodes = steps.map(s => {
    const pos = g.node(s.task.id)
    return {
      id: s.task.id,
      type: 'flowTask',
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { task: s.task, step: s.step, prefix },
      draggable: false,
    }
  })

  return { nodes, edges }
}

export default function FlowGraph({ steps, prefix }) {
  const { nodes, edges } = useMemo(() => buildLayout(steps, prefix), [steps, prefix])
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
        elementsSelectable={false}
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
