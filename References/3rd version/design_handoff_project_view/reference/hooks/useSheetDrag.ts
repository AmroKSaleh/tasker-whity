// useSheetDrag.ts
// Drag-to-dismiss for bottom sheets. Attach `handlers` to the drag handle
// element; read `dy` to translate the sheet.

import { useRef, useState } from 'react';

export function useSheetDrag(onDismiss: () => void, threshold = 80) {
  const [dy, setDy] = useState(0);
  const startY = useRef(0);
  const dragging = useRef(false);

  function onPointerDown(e: React.PointerEvent) {
    dragging.current = true;
    startY.current = e.clientY;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    setDy(Math.max(0, e.clientY - startY.current));
  }
  function onPointerUp() {
    dragging.current = false;
    if (dy > threshold) {
      setDy(window.innerHeight);
      requestAnimationFrame(() => { onDismiss(); setDy(0); });
    } else {
      setDy(0);
    }
  }

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp },
    style: { transform: `translateY(${dy}px)`, transition: dy ? 'none' : 'transform 240ms cubic-bezier(0.2,0.7,0.3,1)' },
  };
}
