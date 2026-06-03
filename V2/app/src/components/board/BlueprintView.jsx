import { useMemo, useState, useEffect, useRef, createContext, useContext } from 'react'
import { ReactFlow, Background, Controls, Handle, Position, getSmoothStepPath, BaseEdge, useReactFlow, useEdges, useNodes } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

const NODE_WIDTH = 200
const NODE_HEIGHT = 90
const SLOT_HEIGHT = 120
const COLUMN_WIDTH = 240
const COLUMN_GAP = 100
const HEADER_HEIGHT = 36
const HEADER_TOP_PAD = 16
const CANVAS_BG = 'var(--color-surf-2)'
const BRIDGE_R = 6

const FLOW_COLORS = [
  '#D97757', '#4A90D9', '#8B5CF6', '#10B981',
  '#EC4899', '#06B6D4', '#F59E0B', '#EF4444',
]

const IsolationContext = createContext(null)

// ── Segment-segment intersection ──────────────────────────────────────────────
function segIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
  const dx1 = ax2 - ax1, dy1 = ay2 - ay1
  const dx2 = bx2 - bx1, dy2 = by2 - by1
  const denom = dx1 * dy2 - dy1 * dx2
  if (Math.abs(denom) < 0.5) return null
  const t = ((bx1 - ax1) * dy2 - (by1 - ay1) * dx2) / denom
  const u = ((bx1 - ax1) * dy1 - (by1 - ay1) * dx1) / denom
  if (t > 0.05 && t < 0.95 && u > 0.05 && u < 0.95) {
    return { x: ax1 + t * dx1, y: ay1 + t * dy1 }
  }
  return null
}

// Approximate a smoothstep edge as 3 line segments for crossing detection
function edgePolyline(sx, sy, tx, ty) {
  const mx = sx + (tx - sx) * 0.5
  return [
    [sx, sy, mx, sy],
    [mx, sy, mx, ty],
    [mx, ty, tx, ty],
  ]
}

// ── Crossing detector — lives inside ReactFlow context ────────────────────────
function CrossingDetector({ onCrossings }) {
  const nodes = useNodes()
  const edges = useEdges()
  const prevRef = useRef('')

  useEffect(() => {
    if (!nodes.length || !edges.length) return

    // Build node centre-right / centre-left positions
    const right = new Map()  // node id → exit point (right handle)
    const left  = new Map()  // node id → entry point (left handle)
    nodes.forEach(n => {
      if (n.type !== 'taskNode') return
      right.set(n.id, { x: n.position.x + NODE_WIDTH, y: n.position.y + NODE_HEIGHT / 2 })
      left.set(n.id, { x: n.position.x,              y: n.position.y + NODE_HEIGHT / 2 })
    })

    // Build polylines for each edge
    const polys = edges
      .map(e => {
        const s = right.get(e.source)
        const t = left.get(e.target)
        if (!s || !t) return null
        return { id: e.id, segs: edgePolyline(s.x, s.y, t.x, t.y) }
      })
      .filter(Boolean)

    const key = polys.map(p => p.id + p.segs.flat().join(',')).join('|')
    if (key === prevRef.current) return
    prevRef.current = key

    // Find all crossing points per edge
    const crossMap = new Map(polys.map(p => [p.id, []]))
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        for (const [ax1, ay1, ax2, ay2] of polys[i].segs) {
          for (const [bx1, by1, bx2, by2] of polys[j].segs) {
            const pt = segIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2)
            if (pt) {
              // Edge i goes under edge j (j renders on top → i gets the bridge circle)
              crossMap.get(polys[i].id).push(pt)
            }
          }
        }
      }
    }

    onCrossings(crossMap)
  }, [nodes, edges])

  return null
}

// ── Custom edge ───────────────────────────────────────────────────────────────
function BridgeEdge({ source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }) {
  const isolatedSet = useContext(IsolationContext)
  const isDimmed = isolatedSet ? (!isolatedSet.has(source) || !isolatedSet.has(target)) : false
  const color = data?.color ?? '#D97757'
  const crossings = data?.crossings ?? []
  const [edgePath] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 12,
  })

  return (
    <g style={{ opacity: isDimmed ? 0 : 1, pointerEvents: isDimmed ? 'none' : 'all', transition: 'opacity 0.2s' }}>
      <BaseEdge path={edgePath} style={{ stroke: color, strokeWidth: 1.5 }} markerEnd={markerEnd} />
      {crossings.map((pt, i) => (
        <g key={i}>
          <circle cx={pt.x} cy={pt.y} r={BRIDGE_R + 1} style={{ fill: CANVAS_BG }} />
          <circle cx={pt.x} cy={pt.y} r={BRIDGE_R} fill="none" stroke={color} strokeWidth={1.5} />
        </g>
      ))}
    </g>
  )
}

// ── Nodes ─────────────────────────────────────────────────────────────────────
function SectionLabel({ data }) {
  return (
    <div style={{
      width: NODE_WIDTH, padding: '7px 12px',
      background: 'var(--color-surf-2)', border: '1px solid var(--color-line-2)',
      borderRadius: 6, fontFamily: 'monospace', fontSize: 10,
      letterSpacing: '0.1em', textTransform: 'uppercase',
      color: 'var(--color-mute)', fontWeight: 600, textAlign: 'center',
      pointerEvents: 'none',
    }}>
      {data.name}
    </div>
  )
}

function TaskNode({ data }) {
  const { task, flowColor, isSelected, isDimmed, isolationOrder } = data
  const baseBorderColor = flowColor
    ? (task.status === 'done' ? '#4ade80' : flowColor)
    : (task.status === 'done' ? '#4ade80' : 'var(--color-line)')
  const selectionColor = flowColor ?? '#D97757'
  const borderColor = isSelected ? selectionColor : baseBorderColor
  const dotColor = borderColor

  return (
    <div style={{
      width: NODE_WIDTH, minHeight: NODE_HEIGHT,
      background: 'var(--color-paper)',
      border: `${isSelected ? 2 : 1.5}px solid ${borderColor}`,
      borderRadius: 8, padding: '10px 12px',
      fontFamily: 'inherit', boxSizing: 'border-box',
      boxShadow: isSelected ? `0 0 0 3px ${selectionColor}2e` : undefined,
      cursor: 'pointer',
      opacity: isDimmed ? 0 : 1,
      pointerEvents: isDimmed ? 'none' : undefined,
      transition: 'opacity 0.2s',
    }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
        {isolationOrder != null ? (
          <span style={{ fontFamily: 'monospace', fontSize: 10, color: dotColor, letterSpacing: '0.06em', fontWeight: 700 }}>
            STEP {isolationOrder}
          </span>
        ) : task.short_id != null && (
          <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--color-mute-2)', letterSpacing: '0.06em' }}>
            #{task.short_id}
          </span>
        )}
      </div>
      <div style={{
        fontSize: 12.5, fontWeight: 600, color: 'var(--color-ink)', lineHeight: 1.35,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        overflow: 'hidden', marginBottom: task.priority ? 5 : 0,
      }}>
        {task.text}
      </div>
      {task.priority && (
        <div style={{ fontFamily: 'monospace', fontSize: 9.5, letterSpacing: '0.06em', color: 'var(--color-mute)', textTransform: 'uppercase' }}>
          {task.priority}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />
    </div>
  )
}

const nodeTypes = { taskNode: TaskNode, sectionLabel: SectionLabel }
const edgeTypes = { bridge: BridgeEdge }

// ── Connected-component detection ─────────────────────────────────────────────
function detectFlows(tasks) {
  const taskById = new Map(tasks.map(t => [t.id, t]))
  const adj = new Map(tasks.map(t => [t.id, new Set()]))
  tasks.forEach(t => {
    const src = t.input?.source_task_id
    if (src && adj.has(src)) { adj.get(t.id).add(src); adj.get(src).add(t.id) }
  })
  const visited = new Set()
  const flows = []
  tasks.forEach(t => {
    if (visited.has(t.id) || adj.get(t.id).size === 0) return
    const taskIds = new Set()
    const queue = [t.id]
    visited.add(t.id)
    while (queue.length) {
      const curr = queue.shift(); taskIds.add(curr)
      for (const nb of adj.get(curr)) { if (!visited.has(nb)) { visited.add(nb); queue.push(nb) } }
    }
    const hasIncoming = new Set([...taskIds].filter(id => {
      const task = taskById.get(id)
      return task?.input?.source_task_id && taskIds.has(task.input.source_task_id)
    }))
    const roots = [...taskIds].filter(id => !hasIncoming.has(id))
    const rootTask = taskById.get(roots[0])
    const words = rootTask?.text.split(' ').slice(0, 3).join(' ') ?? ''
    flows.push({
      id: `flow-${flows.length}`,
      rootTaskId: roots[0] ?? null,
      autoName: words + (rootTask && words.length < rootTask.text.length ? '…' : ''),
      taskIds,
      color: FLOW_COLORS[flows.length % FLOW_COLORS.length],
    })
  })
  return flows
}

// ── Topological depth ──────────────────────────────────────────────────────────
function getTopologicalDepths(tasks) {
  const taskById = new Map(tasks.map(t => [t.id, t]))
  const depths = new Map()
  function depth(id, stack = new Set()) {
    if (depths.has(id)) return depths.get(id)
    if (stack.has(id)) return 0
    stack.add(id)
    const src = taskById.get(id)?.input?.source_task_id
    const d = src && taskById.has(src) ? depth(src, stack) + 1 : 0
    depths.set(id, d); return d
  }
  tasks.forEach(t => depth(t.id))
  return depths
}

// ── Layout ─────────────────────────────────────────────────────────────────────
function buildLayout(visibleTasks, sections, flows) {
  const flowByTaskId = new Map()
  flows.forEach(f => f.taskIds.forEach(id => flowByTaskId.set(id, f)))
  const depths = getTopologicalDepths(visibleTasks)
  const sortedSections = sections
    .slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .filter(s => visibleTasks.some(t => t.section_id === s.id))
  const visibleIds = new Set(visibleTasks.map(t => t.id))
  const nodes = []
  sortedSections.forEach((section, si) => {
    const x = si * (COLUMN_WIDTH + COLUMN_GAP)
    const sectionTasks = visibleTasks
      .filter(t => t.section_id === section.id)
      .sort((a, b) => (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0))
    nodes.push({ id: `section-${section.id}`, type: 'sectionLabel', data: { name: section.name }, position: { x, y: 0 }, draggable: false, selectable: false })
    sectionTasks.forEach((task, ti) => {
      const flow = flowByTaskId.get(task.id)
      nodes.push({ id: task.id, type: 'taskNode', data: { task, flowColor: flow?.color ?? null }, position: { x, y: HEADER_HEIGHT + HEADER_TOP_PAD + ti * SLOT_HEIGHT } })
    })
  })
  const edges = visibleTasks
    .filter(t => t.input?.source_task_id && visibleIds.has(t.input.source_task_id))
    .map(t => {
      const flow = flowByTaskId.get(t.id)
      return { id: `${t.input.source_task_id}->${t.id}`, source: t.input.source_task_id, target: t.id, type: 'bridge', data: { color: flow?.color ?? '#D97757', crossings: [] }, markerEnd: { type: 'arrowclosed', color: flow?.color ?? '#D97757' } }
    })
  return { nodes, edges }
}

// ── ReactFlow inner — has access to context ────────────────────────────────────
function FlowInner({ edges: initEdges, isolatedTaskId, isolatedSet }) {
  const { setEdges, fitView } = useReactFlow()

  function handleCrossings(crossMap) {
    setEdges(prev => prev.map(e => ({
      ...e,
      // Preserve isDimmed when crossings update
      data: { ...e.data, crossings: crossMap.get(e.id) ?? [] },
    })))
  }

  // Move camera to show isolated cluster — nodes stay in place
  useEffect(() => {
    if (!isolatedTaskId || !isolatedSet) return
    const nodeIds = [...isolatedSet].map(id => ({ id }))
    const t = setTimeout(() => fitView({ nodes: nodeIds, padding: 1.8, duration: 350 }), 50)
    return () => clearTimeout(t)
  }, [isolatedTaskId])

  return <CrossingDetector onCrossings={handleCrossings} />
}

// ── Main ───────────────────────────────────────────────────────────────────────
export default function BlueprintView({ tasks, sections, flowNames = {}, onRenameFlow, onExit, onTaskSelect, onDeselect, selectedTaskId }) {
  const [sectionFilter, setSectionFilter] = useState(null)
  const [selectedFlowIds, setSelectedFlowIds] = useState(new Set())
  const [editingFlowId, setEditingFlowId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [isolatedTaskId, setIsolatedTaskId] = useState(null)
  const editInputRef = useRef(null)

  // ── Isolation ──────────────────────────────────────────────────────────────────
  // Set of task IDs to show when isolation is active: the doubled-clicked task
  // plus its direct predecessors (input) and successors (output).
  const isolatedSet = useMemo(() => {
    if (!isolatedTaskId) return null
    const set = new Set([isolatedTaskId])
    const root = tasks.find(t => t.id === isolatedTaskId)
    if (root?.input?.source_task_id) set.add(root.input.source_task_id)
    tasks.forEach(t => { if (t.input?.source_task_id === isolatedTaskId) set.add(t.id) })
    return set
  }, [isolatedTaskId, tasks])

  const isolatedTask = useMemo(
    () => isolatedTaskId ? tasks.find(t => t.id === isolatedTaskId) : null,
    [isolatedTaskId, tasks]
  )

  // Escape: close task panel (handled by TaskDetailPanel) → exit isolation → exit blueprint
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return
      if (selectedTaskId) return          // TaskDetailPanel handles its own Escape
      if (isolatedTaskId) { setIsolatedTaskId(null); return }
      onExit?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selectedTaskId, isolatedTaskId, onExit])

  // Section filter (no isolation) — used as the base for flow detection so colors stay stable
  const sectionOnlyFiltered = useMemo(
    () => sectionFilter ? tasks.filter(t => t.section_id === sectionFilter) : tasks,
    [tasks, sectionFilter]
  )
  // Flows always computed from the full (non-isolated) section view so colors don't reset on isolation
  const flows = useMemo(() => detectFlows(sectionOnlyFiltered), [sectionOnlyFiltered])

  // Isolation only affects camera + dimming — no tasks are removed from the layout
  const visibleTasks = useMemo(() => {
    if (selectedFlowIds.size === 0) return sectionOnlyFiltered
    const allowed = new Set(flows.filter(f => selectedFlowIds.has(f.id)).flatMap(f => [...f.taskIds]))
    return sectionOnlyFiltered.filter(t => allowed.has(t.id))
  }, [sectionOnlyFiltered, flows, selectedFlowIds])

  // Layout — only recomputes when tasks/sections/flows change, NOT on selection change
  const { nodes: layoutNodes, edges } = useMemo(() => buildLayout(visibleTasks, sections, flows), [visibleTasks, sections, flows])

  // Topological execution order for the isolated cluster
  const isolationOrderMap = useMemo(() => {
    if (!isolatedSet) return null
    const isolated = tasks.filter(t => isolatedSet.has(t.id))
    const taskById = new Map(isolated.map(t => [t.id, t]))
    const depths = new Map()
    function depth(id, stack = new Set()) {
      if (depths.has(id)) return depths.get(id)
      if (stack.has(id)) return 0
      stack.add(id)
      const src = taskById.get(id)?.input?.source_task_id
      const d = src && taskById.has(src) ? depth(src, stack) + 1 : 0
      depths.set(id, d)
      return d
    }
    isolated.forEach(t => depth(t.id))
    const sorted = isolated.slice().sort((a, b) => {
      const da = depths.get(a.id) ?? 0
      const db = depths.get(b.id) ?? 0
      if (da !== db) return da - db
      return (a.sort_order ?? 0) - (b.sort_order ?? 0)
    })
    return new Map(sorted.map((t, i) => [t.id, i + 1]))
  }, [isolatedSet, tasks])

  // Selection + isolation overlay — cheap remap, keeps layout stable
  const nodes = useMemo(
    () => layoutNodes.map(n => ({
      ...n,
      data: {
        ...n.data,
        isSelected: n.id === selectedTaskId,
        isDimmed: isolatedSet ? !isolatedSet.has(n.id) : false,
        isolationOrder: isolationOrderMap?.get(n.id) ?? null,
      },
    })),
    [layoutNodes, selectedTaskId, isolatedSet, isolationOrderMap]
  )

  function toggleFlow(id) {
    setSelectedFlowIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  const sortedSections = useMemo(() => sections.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)), [sections])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: CANVAS_BG, colorScheme: 'light dark' }}>
      {/* Exit button — bottom-right */}
      {onExit && (
        <button
          onClick={onExit}
          style={{
            position: 'absolute', bottom: 16, right: 16, zIndex: 10,
            fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
            padding: '4px 12px', borderRadius: 20, border: '1px solid var(--color-line)',
            color: 'var(--color-mute)', background: 'var(--color-paper)', cursor: 'pointer',
          }}
        >
          ← Exit Blueprint
        </button>
      )}

      {/* Top-left: isolation indicator OR section filter pills */}
      <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {isolatedSet ? (
          <>
            <span style={{
              fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
              padding: '3px 10px', borderRadius: 20, border: '1px solid #D97757',
              color: '#D97757', background: 'var(--color-paper)',
            }}>
              ◈ Isolated
            </span>
            <span style={{ fontSize: 12, color: 'var(--color-ink-2)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {isolatedTask?.text}
            </span>
            <button
              onClick={() => setIsolatedTaskId(null)}
              style={{
                fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
                padding: '3px 10px', borderRadius: 20, border: '1px solid var(--color-line)',
                color: 'var(--color-mute)', background: 'var(--color-paper)', cursor: 'pointer',
              }}
            >
              × All tasks
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setSectionFilter(null)} style={btnStyle(sectionFilter === null)}>All</button>
            {sortedSections.map(s => <button key={s.id} onClick={() => setSectionFilter(s.id === sectionFilter ? null : s.id)} style={btnStyle(sectionFilter === s.id)}>{s.name}</button>)}
          </>
        )}
      </div>

      {/* Flow legend — hidden while isolated */}
      {!isolatedSet && flows.length > 0 && (
        <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, background: 'var(--color-paper)', border: '1px solid var(--color-line-2)', borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 170, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-mute)' }}>Flows</span>
            {selectedFlowIds.size > 0 && <button onClick={() => setSelectedFlowIds(new Set())} style={{ fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-mute)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Clear</button>}
          </div>
          {flows.map(f => {
            const active = selectedFlowIds.has(f.id)
            const dimmed = selectedFlowIds.size > 0 && !active
            const displayName = (f.rootTaskId && flowNames[f.rootTaskId]) || f.autoName
            const isEditing = editingFlowId === f.id
            return (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 6, border: `1px solid ${active ? f.color : 'transparent'}`, background: active ? `${f.color}14` : 'transparent', opacity: dimmed ? 0.35 : 1, transition: 'opacity 0.15s' }}>
                <span onClick={() => toggleFlow(f.id)} style={{ width: 8, height: 8, borderRadius: '50%', background: f.color, flexShrink: 0, cursor: 'pointer' }} />
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    value={editingName}
                    onChange={e => setEditingName(e.target.value)}
                    onBlur={() => { onRenameFlow?.(f.rootTaskId, editingName.trim() || f.autoName); setEditingFlowId(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') { onRenameFlow?.(f.rootTaskId, editingName.trim() || f.autoName); setEditingFlowId(null) } if (e.key === 'Escape') setEditingFlowId(null) }}
                    style={{ flex: 1, fontSize: 11.5, color: 'var(--color-ink)', background: 'var(--color-surf-2)', border: '1px solid var(--color-accent, #D97757)', borderRadius: 4, padding: '1px 5px', outline: 'none', minWidth: 0 }}
                  />
                ) : (
                  <span
                    onClick={() => toggleFlow(f.id)}
                    onDoubleClick={() => { setEditingFlowId(f.id); setEditingName(displayName); setTimeout(() => editInputRef.current?.select(), 0) }}
                    title="Double-click to rename"
                    style={{ fontSize: 11.5, color: 'var(--color-ink-2)', lineHeight: 1.3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                  >
                    {displayName}
                  </span>
                )}
                <span onClick={() => toggleFlow(f.id)} style={{ fontFamily: 'monospace', fontSize: 9.5, color: 'var(--color-mute)', flexShrink: 0, cursor: 'pointer' }}>{f.taskIds.size}</span>
              </div>
            )
          })}
        </div>
      )}

      {visibleTasks.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-mute)', fontSize: 13 }}>No tasks to display.</div>
      ) : (
        <IsolationContext.Provider value={isolatedSet}>
          <ReactFlow
            nodes={nodes} edges={edges}
            nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            style={{ background: CANVAS_BG }}
            fitView fitViewOptions={{ padding: 0.15 }}
            onlyRenderVisibleElements={false}
            nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
            onNodeClick={(_, node) => { if (node.type === 'taskNode') onTaskSelect?.(node.id) }}
            onNodeDoubleClick={(_, node) => { if (node.type === 'taskNode') setIsolatedTaskId(node.id) }}
            onPaneClick={() => onDeselect?.()}
            panOnScroll zoomOnScroll zoomOnDoubleClick={false} minZoom={0.05} maxZoom={2}
          >
            <FlowInner edges={edges} isolatedTaskId={isolatedTaskId} isolatedSet={isolatedSet} />
            <Background color="var(--color-line-2)" gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </IsolationContext.Provider>
      )}
    </div>
  )
}

function btnStyle(active) {
  return {
    fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
    padding: '3px 10px', borderRadius: 20, border: '1px solid',
    borderColor: active ? '#D97757' : 'var(--color-line)',
    color: active ? '#D97757' : 'var(--color-mute)',
    background: 'var(--color-paper)', cursor: 'pointer',
  }
}
