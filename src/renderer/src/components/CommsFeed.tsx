import { useEffect, useRef, useState } from 'react'
import type { Deployment, MechClass } from '../../../shared/types'
import { sfx } from '../audio/sfx'
import { computeCommsMessages, type CommsMessage } from '../comms'
import { CREW } from '../crew'
import { useTypewriter } from '../motion'

/** How long a transmission stays on screen. */
const LIFETIME_MS = 6000
/** One radio channel: transmissions that land together are spaced out. */
const REVEAL_GAP_MS = 900
/** Length of the fade-out that precedes expiry (matches command.css). */
const EXIT_MS = 280
const MAX_VISIBLE = 3
/** Typing starts once the static burst has cleared. */
const TUNE_IN_MS = 160
/**
 * The debrief opens right as a completion call lands, so traffic already on
 * screen is held while any modal dialog covers the bay and gets at least
 * HOLD_MS - HOLD_POLL_MS of airtime once it closes.
 */
const HOLD_MS = 4000
const HOLD_POLL_MS = 500

function isModalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}

interface ScheduledMessage extends CommsMessage {
  key: string
  revealAt: number
  expireAt: number
}

/**
 * Head/torso crop per chassis, as a focus point in the idle art (percent of
 * the image) and a zoom factor relative to the portrait frame's height.
 */
const PORTRAIT_CROP: Record<MechClass, { x: number; y: number; zoom: number }> = {
  atlas: { x: 52, y: 30, zoom: 1.75 },
  marauder: { x: 50, y: 23, zoom: 2 },
  raven: { x: 56, y: 36, zoom: 1.8 },
  catapult: { x: 49, y: 36, zoom: 1.7 },
  locust: { x: 48, y: 35, zoom: 2.1 }
}

/**
 * RTS-style radio chatter overlaid on the bay. Subscribes to the same state
 * broadcasts as App and turns real deployment status transitions into short
 * transmissions (see comms.ts); nothing here is invented or timed on its own.
 */
export function CommsFeed(): React.JSX.Element {
  const [feed, setFeed] = useState<{ items: ScheduledMessage[]; clock: number }>({
    items: [],
    clock: 0
  })
  const previousRef = useRef<Deployment[] | null>(null)
  const lastRevealRef = useRef(0)
  const sequenceRef = useRef(0)

  useEffect(() => {
    let disposed = false
    // Seed the baseline so missions already in flight at boot stay quiet.
    window.mechbay
      .getState()
      .then((initial) => {
        if (!disposed && !previousRef.current) previousRef.current = initial.deployments
      })
      .catch(() => {})
    const off = window.mechbay.onStateChange((next) => {
      const previous = previousRef.current
      previousRef.current = next.deployments
      if (!previous) return
      const messages = computeCommsMessages(previous, next)
      if (messages.length === 0) return
      const now = Date.now()
      const scheduled = messages.map((message) => {
        const revealAt = Math.max(now, lastRevealRef.current + REVEAL_GAP_MS)
        lastRevealRef.current = revealAt
        return {
          ...message,
          key: `${message.id}:${sequenceRef.current++}`,
          revealAt,
          expireAt: revealAt + LIFETIME_MS
        }
      })
      setFeed((current) => ({
        items: [...current.items.filter((item) => item.expireAt > now), ...scheduled],
        clock: now
      }))
    })
    return () => {
      disposed = true
      off()
    }
  }, [])

  // Wake up at the next reveal / fade-out / expiry boundary, then re-render.
  useEffect(() => {
    const boundaries = feed.items
      .flatMap((item) => [item.revealAt, item.expireAt - EXIT_MS, item.expireAt])
      .filter((time) => time > feed.clock)
    if (boundaries.length === 0) return
    // While a modal covers the bay, keep polling so on-screen traffic can be held.
    const onScreen = feed.items.some((item) => item.revealAt <= feed.clock)
    const wakeAt = Math.min(
      ...boundaries,
      onScreen && isModalOpen() ? Date.now() + HOLD_POLL_MS : Infinity
    )
    const timer = setTimeout(
      () => {
        const now = Date.now()
        const held = isModalOpen()
        setFeed((current) => ({
          items: current.items
            .map((item) =>
              held && item.revealAt <= now && item.expireAt < now + HOLD_MS
                ? { ...item, expireAt: now + HOLD_MS }
                : item
            )
            .filter((item) => item.expireAt > now),
          clock: now
        }))
      },
      Math.max(0, wakeAt - Date.now())
    )
    return () => clearTimeout(timer)
  }, [feed])

  const visible = feed.items.filter((item) => item.revealAt <= feed.clock).slice(-MAX_VISIBLE)

  return (
    <div className="comms-feed" aria-label="Mech radio" aria-live="polite">
      {visible.map((item, index) => (
        <Transmission
          key={item.key}
          message={item}
          // Older traffic collapses to a one-line log entry so a burst of
          // calls covers as little of the field as possible.
          compact={index < visible.length - 1}
          leaving={feed.clock >= item.expireAt - EXIT_MS}
        />
      ))}
    </div>
  )
}

function Transmission({
  message,
  compact,
  leaving
}: {
  message: CommsMessage
  compact: boolean
  leaving: boolean
}): React.JSX.Element {
  const typed = useTypewriter(message.bark, { startDelayMs: TUNE_IN_MS })
  const crop = PORTRAIT_CROP[message.mechClass]
  const typing = typed < message.bark.length

  useEffect(() => {
    // Deferred so StrictMode's mount/unmount/mount only keys the mic once.
    const timer = setTimeout(() => sfx.play('radio', { rate: message.radioRate, volume: 0.8 }), 0)
    return () => clearTimeout(timer)
  }, [message.radioRate])

  return (
    <div
      className={`comms-msg tone-${message.tone}${compact ? ' is-compact' : ''}${
        leaving ? ' is-leaving' : ''
      }`}
    >
      <span
        className="comms-portrait"
        aria-hidden="true"
        style={
          {
            '--crop-x': `${crop.x}%`,
            '--crop-y': `${crop.y}%`,
            '--crop-zoom': crop.zoom
          } as React.CSSProperties
        }
      >
        <img src={CREW[message.mechClass].image} alt="" draggable={false} />
      </span>
      <span className="comms-body">
        <span className="comms-meta">
          <span className="comms-callsign">{message.callsign}</span>
          <span className="comms-channel">{message.channel}</span>
        </span>
        <span className="comms-bark">
          <span className="sr-only">
            {message.callsign}: {message.bark}
            {message.detail ? ` ${message.detail}` : ''}
          </span>
          {/* The invisible full line reserves the final wrap, so typing never reflows. */}
          <span className="comms-bark-ghost" aria-hidden="true">
            {message.bark}
          </span>
          <span className="comms-bark-typed" aria-hidden="true">
            {message.bark.slice(0, typed)}
            {typing && <i className="comms-caret" />}
          </span>
        </span>
        {message.detail && (
          <span className="comms-detail" aria-hidden="true">
            {message.detail}
          </span>
        )}
      </span>
    </div>
  )
}
