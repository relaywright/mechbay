import type {
  AppState,
  Companion,
  Deployment,
  DeploymentStatus,
  Facility,
  MechClass
} from '../../shared/types'
import { waitingInLine } from '../../shared/mission-queue'

/**
 * Radio comms: RTS-style unit acknowledgements derived purely from real
 * deployment status transitions. Mirrors the diff-previous-vs-next pattern
 * of game/deployment-transitions.ts, but emits one-line "barks" for the HUD
 * comms feed instead of scene actions. Everything here is deterministic
 * (variants are picked by hashing the deployment id) so tests stay stable.
 */

export type CommsEvent =
  | 'acknowledged'
  | 'queued'
  | 'working'
  | 'resumed'
  | 'awaiting-input'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type CommsTone = 'status' | 'alert' | 'success' | 'failure' | 'muted'

export interface CommsTransition {
  event: CommsEvent
  deployment: Deployment
}

export interface CommsMessage {
  /** Stable per deployment + event; the feed adds its own sequence for keys. */
  id: string
  deploymentId: string
  companionId: string
  event: CommsEvent
  mechClass: MechClass
  callsign: string
  channel: string
  bark: string
  /** Optional second line built only from real deployment data. */
  detail?: string
  tone: CommsTone
  /** Playback-rate multiplier so each chassis' radio sounds slightly different. */
  radioRate: number
}

export const COMMS_CHANNELS: Record<CommsEvent, string> = {
  acknowledged: 'ORDERS',
  queued: 'HOLDING',
  working: 'SITREP',
  resumed: 'SITREP',
  'awaiting-input': 'INPUT REQ',
  completed: 'COMPLETE',
  failed: 'FAILED',
  cancelled: 'RECALL'
}

const TONES: Record<CommsEvent, CommsTone> = {
  acknowledged: 'status',
  queued: 'muted',
  working: 'status',
  resumed: 'status',
  'awaiting-input': 'alert',
  completed: 'success',
  failed: 'failure',
  cancelled: 'muted'
}

/** Heavier chassis get a lower, slower radio; scouts a brighter one. */
export const RADIO_RATE: Record<MechClass, number> = {
  atlas: 0.86,
  catapult: 0.93,
  marauder: 0.98,
  raven: 1.08,
  locust: 1.16
}

/**
 * Per-chassis line bank. `{facility}` is replaced with the facility name.
 * Keep every line at seven words or fewer (the facility counts as one).
 */
export const BARKS: Record<MechClass, Record<CommsEvent, readonly string[]>> = {
  // Heavy assault: stoic, weighty.
  atlas: {
    acknowledged: [
      'Acknowledged. Advancing on {facility}.',
      'Atlas moving. {facility} is ours.',
      'Heavy armor rolling. Target: {facility}.',
      'Understood, Commander. Moving out.'
    ],
    queued: [
      'Standing by for an open slot.',
      'Holding position until the lane clears.',
      'Queued. Atlas will wait.'
    ],
    working: [
      'On station. Breaking ground at {facility}.',
      'In position. Commencing work.',
      'Digging in at {facility}.'
    ],
    resumed: ['Orders received. Resuming.', 'Copy. Pressing forward.', 'Understood. Back to work.'],
    'awaiting-input': [
      'Commander, I need your call.',
      'Holding. Awaiting your orders.',
      'Decision point. Your word, Commander.'
    ],
    completed: [
      'Objective secured. Returning to bay.',
      '{facility} is done. Coming home.',
      'Mission complete. Atlas returning.'
    ],
    failed: [
      'Taking heavy damage. Mission failed.',
      'Objective lost. Atlas pulling back.',
      'Could not hold {facility}.'
    ],
    cancelled: [
      'Recall acknowledged. Returning to bay.',
      'Standing down. Heading home.',
      'Orders rescinded. Atlas withdrawing.'
    ]
  },
  // Precision strike: surgical, clipped.
  marauder: {
    acknowledged: [
      'Target {facility}. Engaging.',
      'Confirmed. Precision strike authorized.',
      'Marauder. Vector locked.',
      'Copy. Clean cuts only.'
    ],
    queued: ['Queued. Holding fire.', 'Standby. Awaiting clear lane.', 'Holding. Weapons cold.'],
    working: [
      'In range. Cutting now.',
      'Contact at {facility}. Engaging.',
      'Scalpel out. Working.'
    ],
    resumed: ['Input logged. Resuming strike.', 'Copy. Re-engaging.', 'Confirmed. Continuing.'],
    'awaiting-input': [
      'Need confirmation before next cut.',
      'Holding. Request clearance.',
      'Awaiting authorization, Commander.'
    ],
    completed: [
      'Clean hit. Target neutralized.',
      '{facility} done. Minimal collateral.',
      'Strike complete. Disengaging.'
    ],
    failed: [
      'Strike failed. Aborting.',
      'No effect on target. Failed.',
      'Miss. Marauder disengaging.'
    ],
    cancelled: ['Abort confirmed. Disengaging.', 'Weapons cold. Returning.', 'Strike called off.']
  },
  // Recon scout: terse, whispered intel.
  raven: {
    acknowledged: [
      'Raven. Slipping in quiet.',
      'Copy. Eyes on {facility} soon.',
      'Going dark. Moving to {facility}.',
      'Quiet approach. On my way.'
    ],
    queued: ['Holding in cover. Queued.', 'Waiting for a gap.', 'Parked. Say when.'],
    working: [
      'Inside {facility}. Mapping now.',
      'Sensors up. Reading everything.',
      'Eyes on. Collecting intel.'
    ],
    resumed: [
      'Got it. Back in the shadows.',
      'Copy. Resuming sweep.',
      'Understood. Continuing recon.'
    ],
    'awaiting-input': [
      'Found something. Need your call.',
      'Contact. Awaiting instructions.',
      'Pausing. Need your eyes.'
    ],
    completed: [
      'Intel secured. Exfiltrating.',
      '{facility} mapped. Coming home.',
      'Sweep complete. Nothing missed.'
    ],
    failed: [
      'Compromised. Pulling out.',
      'Lost the trail at {facility}.',
      'Spotted. Recon failed.'
    ],
    cancelled: ['Aborting. Ghosting out.', 'Copy. Leaving no trace.', 'Recall heard. Withdrawing.']
  },
  // Ranged support: calm artillery officer.
  catapult: {
    acknowledged: [
      'Fire mission received. Plotting solution.',
      'Copy. Ranging on {facility}.',
      'Support moving up. Stand by.',
      'Catapult acknowledging. Moving to position.'
    ],
    queued: [
      'Battery holding. Awaiting slot.',
      'Queued for fire support.',
      'Guns ready. Waiting on the lane.'
    ],
    working: [
      'Solution plotted. Firing for effect.',
      'Rounds on {facility}. Observing.',
      'In position. Laying down support.'
    ],
    resumed: [
      'Adjustment received. Resuming fire.',
      'Copy correction. Firing.',
      'Understood. Resuming barrage.'
    ],
    'awaiting-input': [
      'Request adjustment, Commander.',
      'Holding fire. Need your call.',
      'Awaiting fire authorization.'
    ],
    completed: [
      'Fire mission complete. Target covered.',
      'Rounds complete. {facility} secured.',
      'Barrage finished. Standing down.'
    ],
    failed: [
      'Fire mission failed. Checking guns.',
      'Rounds off target. Mission failed.',
      'Battery down. Unable to complete.'
    ],
    cancelled: [
      'Cease fire acknowledged.',
      'Check fire. Returning to bay.',
      'Mission scrubbed. Guns cold.'
    ]
  },
  // Swarm courier: fast, eager.
  locust: {
    acknowledged: [
      'On it! Heading to {facility}!',
      'Locust here. Moving fast!',
      'Copy! Be there in no time!',
      'Yes, Commander! Running now!'
    ],
    queued: [
      'Queued! Ready when you are!',
      'Waiting my turn. Engines hot!',
      'Holding! Say the word!'
    ],
    working: [
      'Made it! Getting to work!',
      'At {facility}. Running it down!',
      'In and working, Commander!'
    ],
    resumed: ['Got it! Back on it!', 'Copy! Picking up speed!', 'On it again!'],
    'awaiting-input': [
      'Commander? Quick call needed!',
      'Stuck! Need your answer!',
      'Need your input here, Commander!'
    ],
    completed: [
      'Done! Delivered to {facility}!',
      'Package delivered! Heading back!',
      'All done, Commander! Racing home!'
    ],
    failed: [
      'Knocked down. Mission failed!',
      'Tripped up at {facility}!',
      "Couldn't finish. Sorry, Commander!"
    ],
    cancelled: [
      'Turning around! Heading home!',
      'Recall copied! Coming back!',
      'Okay! Returning to bay!'
    ]
  }
}

/** FNV-1a: small, stable string hash for deterministic variant picks. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function pickBark(
  mechClass: MechClass,
  event: CommsEvent,
  deploymentId: string,
  facilityName: string
): string {
  const lines = BARKS[mechClass][event]
  const line = lines[hashString(`${deploymentId}:${event}`) % lines.length]
  return line.replace('{facility}', facilityName)
}

/**
 * Which radio events a deployment's status change implies. Like the scene's
 * transition diff, a deployment first seen already 'working' (from nothing
 * or from 'queued') also gets its order acknowledgement: the main process can
 * flip walking-to → working faster than the renderer observes it. A new
 * queued mission reports holding only when it is in `waiting` (see
 * waitingInLine); without that set every new queued mission does.
 */
export function computeCommsTransitions(
  prevDeployments: Deployment[],
  nextDeployments: Deployment[],
  waiting?: ReadonlySet<string>
): CommsTransition[] {
  const previousStatuses = new Map<string, DeploymentStatus>(
    prevDeployments.map((deployment) => [deployment.id, deployment.status])
  )
  const transitions: CommsTransition[] = []
  const push = (event: CommsEvent, deployment: Deployment): void => {
    transitions.push({ event, deployment })
  }

  for (const deployment of nextDeployments) {
    const prevStatus = previousStatuses.get(deployment.id)
    if (prevStatus === deployment.status) continue
    switch (deployment.status) {
      case 'queued':
        if (prevStatus === undefined && (!waiting || waiting.has(deployment.id)))
          push('queued', deployment)
        break
      case 'walking-to':
        push('acknowledged', deployment)
        break
      case 'working':
        if (prevStatus === 'awaiting-input') {
          push('resumed', deployment)
          break
        }
        if (prevStatus === undefined || prevStatus === 'queued') push('acknowledged', deployment)
        push('working', deployment)
        break
      case 'awaiting-input':
        push('awaiting-input', deployment)
        break
      case 'completed':
      case 'failed':
      case 'cancelled':
        push(deployment.status, deployment)
        break
      case 'returning':
        // Purely a movement phase; the outcome message already covered it.
        break
    }
  }
  return transitions
}

/** Second line: only real numbers from the deployment, never invented telemetry. */
export function commsDetail(event: CommsEvent, deployment: Deployment): string | undefined {
  if (event === 'completed' && deployment.diffStats) {
    const { filesChanged, insertions, deletions } = deployment.diffStats
    return `${filesChanged} file${filesChanged === 1 ? '' : 's'}, +${insertions} −${deletions}`
  }
  if (event === 'failed' && deployment.exitCode !== undefined) {
    return `Exit code ${deployment.exitCode}`
  }
  return undefined
}

export function buildCommsMessage(
  transition: CommsTransition,
  companions: Companion[],
  facilities: Facility[]
): CommsMessage | null {
  const { event, deployment } = transition
  const companionIndex = companions.findIndex((c) => c.id === deployment.companionId)
  const companion = companions[companionIndex]
  if (!companion) return null
  const facility = facilities.find((f) => f.id === deployment.facilityId)
  return {
    id: `${deployment.id}:${event}`,
    deploymentId: deployment.id,
    companionId: companion.id,
    event,
    mechClass: companion.mechClass,
    callsign: companion.name,
    channel: `CH ${String(companionIndex + 1).padStart(2, '0')} · ${COMMS_CHANNELS[event]}`,
    bark: pickBark(companion.mechClass, event, deployment.id, facility?.name ?? 'the objective'),
    detail: commsDetail(event, deployment),
    tone: TONES[event],
    radioRate: RADIO_RATE[companion.mechClass]
  }
}

export function computeCommsMessages(
  prevDeployments: Deployment[],
  nextState: Pick<AppState, 'deployments' | 'companions' | 'facilities' | 'settings'>
): CommsMessage[] {
  return computeCommsTransitions(prevDeployments, nextState.deployments, waitingInLine(nextState))
    .map((transition) => buildCommsMessage(transition, nextState.companions, nextState.facilities))
    .filter((message): message is CommsMessage => message !== null)
}

/**
 * Radio lines reveal one after another, so a holding line can be scheduled
 * to show after its mission already launched. Drops every holding line not
 * yet on screen whose mission is no longer in line. `shownAt` is the feed's
 * last render clock: a line is on screen once revealAt <= shownAt, not merely
 * once its reveal time has passed (the feed's timer can run late).
 */
export function dropStaleHolding<T extends Pick<CommsMessage, 'event' | 'deploymentId'>>(
  items: Array<T & { revealAt: number }>,
  nextState: Pick<AppState, 'deployments' | 'settings'>,
  shownAt: number
): Array<T & { revealAt: number }> {
  const pending = (item: T & { revealAt: number }): boolean =>
    item.event === 'queued' && item.revealAt > shownAt
  if (!items.some(pending)) return items
  const waiting = waitingInLine(nextState)
  return items.filter((item) => !pending(item) || waiting.has(item.deploymentId))
}
