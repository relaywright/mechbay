/**
 * Delegated interface sounds: one document-level listener gives every
 * button, select, and checkbox a click, and enabled buttons a faint hover
 * tick, without touching each component. Add `data-sfx="off"` to an element
 * (or an ancestor) to opt out, e.g. when it plays its own sound.
 */
import { createThrottle } from './mix'
import { sfx } from './sfx'

const CLICK_SELECTOR = 'button, [role="button"], select, input[type="checkbox"]'
const HOVER_SELECTOR = 'button:not(:disabled), [role="button"]:not([aria-disabled="true"])'
const OPT_OUT_SELECTOR = '[data-sfx="off"]'
/** Sweeping the pointer across a toolbar shouldn't become a drumroll. */
const HOVER_THROTTLE_MS = 70

function closestOptedIn(target: EventTarget | null, selector: string): Element | null {
  if (!(target instanceof Element)) return null
  const el = target.closest(selector)
  return el && !el.closest(OPT_OUT_SELECTOR) ? el : null
}

let uninstall: (() => void) | null = null

/** Install once; repeat calls are no-ops. Returns an uninstaller. */
export function installUiSounds(doc: Document = document): () => void {
  if (uninstall) return uninstall
  const hoverAllowed = createThrottle(HOVER_THROTTLE_MS)

  // Capture phase so components that stopPropagation() still click.
  const onClick = (event: MouseEvent): void => {
    if (closestOptedIn(event.target, CLICK_SELECTOR)) sfx.play('ui-click')
  }

  // pointerenter doesn't bubble, so emulate it: pointerover fires for every
  // child, and only counts as an enter when coming from outside the control.
  const onPointerOver = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return
    const el = closestOptedIn(event.target, HOVER_SELECTOR)
    if (!el) return
    const from = event.relatedTarget
    if (from instanceof Node && el.contains(from)) return
    if (hoverAllowed(performance.now())) sfx.play('ui-hover')
  }

  doc.addEventListener('click', onClick, true)
  doc.addEventListener('pointerover', onPointerOver, true)
  uninstall = () => {
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('pointerover', onPointerOver, true)
    uninstall = null
  }
  return uninstall
}
