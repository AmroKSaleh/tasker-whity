import { useEffect } from 'react'

export function useHorizontalWheelScroll(ref) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    function onWheel(e) {
      const { deltaY, deltaX } = e
      if (deltaX !== 0) {
        e.preventDefault()
        el.scrollLeft += deltaX
        return
      }
      if (e.target.closest?.('.col-body')) return
      e.preventDefault()
      el.scrollLeft += deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [ref])
}

export function useScrollProgress(ref) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    function update() {
      const total = el.scrollWidth
      const view  = el.clientWidth
      const left  = el.scrollLeft
      const w = total > 0 ? (view / total) * 100 : 100
      const x = total > view ? (left / (total - view)) * (100 - w) : 0
      el.style.setProperty('--rail-w', `${w}%`)
      el.style.setProperty('--rail-x', `${x}%`)
      el.toggleAttribute('data-fits', total <= view)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', update); ro.disconnect() }
  }, [ref])
}
