import { useLayoutEffect, useRef } from 'react'

/**
 * Sliding underline for a tab strip. Drop it inside the tab container; it
 * measures the container's `button.active` and moves there with a
 * transform-only transition (no layout animation). `activeKey` should change
 * whenever the active tab or the set of tabs changes.
 */
export function TabInk({ activeKey }: { activeKey: string }): React.JSX.Element {
  const inkRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const ink = inkRef.current
    const strip = ink?.parentElement
    if (!ink || !strip) return
    const place = (): void => {
      const active = strip.querySelector<HTMLElement>('button.active')
      if (!active) {
        ink.style.opacity = '0'
        return
      }
      ink.style.opacity = '1'
      ink.style.transform = `translateX(${active.offsetLeft}px) scaleX(${active.offsetWidth})`
    }
    place()
    // Fonts loading or the sidebar resizing moves the tabs without a re-render.
    const observer = new ResizeObserver(place)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [activeKey])

  return <span ref={inkRef} className="tab-ink" aria-hidden="true" />
}
