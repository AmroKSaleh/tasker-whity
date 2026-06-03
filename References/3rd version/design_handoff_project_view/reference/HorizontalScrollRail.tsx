// HorizontalScrollRail.tsx — bottom-of-board scroll affordance (Variant B).
import { useEffect, useRef, useState, RefObject } from 'react';

type Props = {
  scrollerRef: RefObject<HTMLElement>;
};

export function HorizontalScrollRail({ scrollerRef }: Props) {
  const fillRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !fillRef.current) return;

    function update() {
      const total = el!.scrollWidth;
      const view  = el!.clientWidth;
      const left  = el!.scrollLeft;
      const w = total > 0 ? (view / total) * 100 : 100;
      const x = total > view ? (left / (total - view)) * (100 - w) : 0;
      fillRef.current!.style.width = `${w}%`;
      fillRef.current!.style.marginLeft = `${x}%`;
      setFits(total <= view);
    }
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, [scrollerRef]);

  if (fits) return null;

  return (
    <>
      <div className="pointer-events-none absolute bottom-2 left-[22px] right-[22px] h-[3px] overflow-hidden rounded-sm bg-line-2">
        <div
          ref={fillRef}
          className="h-full rounded-sm bg-mute-2 transition-[width,margin] duration-100"
          style={{ width: '0%', marginLeft: '0%' }}
        />
      </div>
      <div className="pointer-events-none absolute bottom-4 right-6 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
        <kbd className="kbd">⇧</kbd>
        <span>+</span>
        <kbd className="kbd">scroll</kbd>
        <span>to pan</span>
      </div>
    </>
  );
}
