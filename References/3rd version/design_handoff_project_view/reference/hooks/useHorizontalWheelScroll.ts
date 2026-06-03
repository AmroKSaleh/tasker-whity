// useHorizontalWheelScroll.ts
// Convert shift+wheel to horizontal pan on a scroll container.
// Trackpad horizontal swipes (deltaX) are already handled natively.

import { useEffect, RefObject } from 'react';

export function useHorizontalWheelScroll(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (e.shiftKey && e.deltaY !== 0) {
        e.preventDefault();
        el!.scrollLeft += e.deltaY;
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref]);
}

// Drives the bottom progress rail (width % + offset %)
export function useScrollProgress(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function update() {
      const total = el!.scrollWidth;
      const view  = el!.clientWidth;
      const left  = el!.scrollLeft;
      const w = total > 0 ? (view / total) * 100 : 100;
      const x = total > view ? (left / (total - view)) * (100 - w) : 0;
      el!.style.setProperty('--rail-w', `${w}%`);
      el!.style.setProperty('--rail-x', `${x}%`);
      el!.toggleAttribute('data-fits', total <= view);
    }
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, [ref]);
}
