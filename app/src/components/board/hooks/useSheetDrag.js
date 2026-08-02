import { useRef, useState, useEffect } from 'react'

export function useSheetDrag(onDismiss, threshold = 80) {
  const [dy, setDy] = useState(() => typeof window !== 'undefined' ? window.innerHeight : 800)
  const [isDragging, setIsDragging] = useState(false)
  const startY = useRef(0)
  const dragging = useRef(false)

  // Slide in on mount
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setDy(0)))
    return () => cancelAnimationFrame(id)
  }, [])

  function onPointerDown(e) {
    dragging.current = true
    setIsDragging(true)
    startY.current = e.clientY
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e) {
    if (!dragging.current) return
    setDy(Math.max(0, e.clientY - startY.current))
  }

  function onPointerUp() {
    dragging.current = false
    setIsDragging(false)
    if (dy > threshold) {
      setDy(window.innerHeight)
      requestAnimationFrame(() => { onDismiss(); setDy(0) })
    } else {
      setDy(0)
    }
  }

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp },
    dy,
    isDragging,
    style: {
      transform: `translateY(${dy}px)`,
      transition: isDragging ? 'none' : 'transform 300ms cubic-bezier(0.2, 0.7, 0.3, 1)',
    },
  }
}
