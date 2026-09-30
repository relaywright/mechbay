import { useEffect, useState, useSyncExternalStore } from 'react'

/**
 * Shared motion helpers for the HTML HUD. CSS animations are already
 * silenced by command.css under `[data-reduce-motion='true']` and the OS
 * `prefers-reduced-motion` query; these hooks give JS-driven motion (typing,
 * count-ups) the same two switches so state still changes, just instantly.
 */

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'

function readReducedMotion(): boolean {
  if (typeof document === 'undefined') return false
  const shell = document.querySelector('.command-shell')
  if (shell?.getAttribute('data-reduce-motion') === 'true') return true
  return window.matchMedia?.(REDUCED_QUERY).matches ?? false
}

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia?.(REDUCED_QUERY)
  query?.addEventListener('change', onChange)
  // The in-app setting lives on the root shell's data attribute.
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-reduce-motion'],
    subtree: true
  })
  return () => {
    query?.removeEventListener('change', onChange)
    observer.disconnect()
  }
}

/** True when either the in-app Reduce motion setting or the OS asks for less motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false)
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

/**
 * Counts from 0 up to `target` once on mount (and again if it changes).
 * Returns `target` immediately under reduced motion.
 */
export function useCountUp(target: number, durationMs = 600, delayMs = 0): number {
  const reduced = useReducedMotion()
  const [value, setValue] = useState(0)

  useEffect(() => {
    if (reduced) return
    let frame = 0
    const startedAt = performance.now() + delayMs
    const tick = (now: number): void => {
      const progress = Math.min(1, Math.max(0, (now - startedAt) / durationMs))
      setValue(Math.round(target * easeOutCubic(progress)))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, durationMs, delayMs, reduced])

  return reduced ? target : value
}

/**
 * Fast radio-style typewriter: ~`perCharMs` per character, but the whole
 * line never takes longer than `maxMs`. Returns how many characters to show.
 */
export function useTypewriter(
  text: string,
  { startDelayMs = 0, perCharMs = 20, maxMs = 500 } = {}
): number {
  const reduced = useReducedMotion()
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (reduced) return
    const step = Math.min(perCharMs, maxMs / Math.max(1, text.length))
    let frame = 0
    const startedAt = performance.now() + startDelayMs
    const tick = (now: number): void => {
      const next = Math.min(text.length, Math.max(0, Math.floor((now - startedAt) / step)))
      setCount(next)
      if (next < text.length) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [text, startDelayMs, perCharMs, maxMs, reduced])

  return reduced ? text.length : count
}
