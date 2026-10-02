/**
 * Renderer-internal event bus. Bridges Phaser (game world events) and
 * React (UI reactions). Keeps Phaser scenes decoupled from React state —
 * Phaser emits, React listens, both stay ignorant of each other's internals.
 */

import mitt from 'mitt'

export type BusEvents = {
  /** Mech dropped onto a facility via drag-drop — triggers deploy flow. */
  dropOnFacility: { companionId: string; facilityId: string }
  /** Single-click on a facility (no drag) — opens the file browser. */
  facilityClicked: { facilityId: string }
  /** Right-click on a facility — requests decommission confirmation. */
  facilityRightClicked: { facilityId: string }
  /** Mech selected or deselected — drives the companion stats panel. */
  companionSelected: { companionId: string | null }
  /** Click on a tile with no facility / mech on it — triggers place-building flow. */
  emptyTileClicked: { tile: { x: number; y: number } }
  /** RECENTER control — animate the bay camera back to its default zoom/pan. */
  bayResetView: void
  /** Heading of the selected mech (degrees from up-screen north) — drives the compass tape. */
  mechHeading: { companionId: string; heading: number }
}

export const bus = mitt<BusEvents>()
