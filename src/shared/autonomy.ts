import type { AgentFamily } from './types'

/**
 * How much a mech may do without asking (P0-12). MechBay turns the level
 * into each CLI's own permission flags; it never claims a limit the CLI
 * does not enforce.
 */
export type AutonomyLevel = 'read' | 'edit' | 'full'

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['read', 'edit', 'full']
export const DEFAULT_AUTONOMY: AutonomyLevel = 'edit'

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  read: 'Read only',
  edit: 'Edit files',
  full: 'Full'
}

export const AUTONOMY_HINTS: Record<AutonomyLevel, string> = {
  read: 'Can look through the project. The CLI blocks any change to project files.',
  edit: 'Can change files in the project. Anything that needs more access is blocked.',
  full: 'Can change files and run any command without asking. Use it only on projects you can restore.'
}

export const USER_RULES_NOTE =
  'CLI settings on this computer or inside the project (allow rules, hooks) can permit more than this level. MechBay cannot remove them.'

export interface AutonomySupport {
  /** False when the runtime controls its own permissions and MechBay cannot limit it. */
  enforced: boolean
  available: Record<AutonomyLevel, boolean>
  /** Why some or all levels are unavailable. */
  reason?: string
}

const ALL = { read: true, edit: true, full: true }
const NONE = { read: false, edit: false, full: false }

export function autonomySupport(runtime: AgentFamily): AutonomySupport {
  switch (runtime) {
    case 'claude':
    case 'codex':
      return { enforced: true, available: ALL }
    case 'gemini':
      return {
        enforced: true,
        available: { read: false, edit: false, full: true },
        reason:
          'MechBay runs Gemini with every action approved, so Full is the only level it can offer.'
      }
    case 'kimi':
    case 'hermes':
    default:
      // Unknown values (a damaged save) are treated like an agent MechBay cannot limit.
      return {
        enforced: false,
        available: NONE,
        reason: 'This agent controls its own permissions. MechBay cannot limit what it does.'
      }
  }
}

/** The level a mission actually runs at, or null when the runtime cannot be limited. */
export function effectiveAutonomy(
  runtime: AgentFamily,
  level: AutonomyLevel
): AutonomyLevel | null {
  const support = autonomySupport(runtime)
  if (!support.enforced) return null
  if (support.available[level]) return level
  return AUTONOMY_LEVELS.find((l) => support.available[l]) ?? null
}

/** A mission's real level; 'unenforced' (MechBay cannot limit it) ranks above Full. */
export type EffectiveAutonomy = AutonomyLevel | 'unenforced'

function rank(level: EffectiveAutonomy): number {
  return level === 'unenforced' ? AUTONOMY_LEVELS.length : AUTONOMY_LEVELS.indexOf(level)
}

/**
 * The level a mech would really run at after a runtime switch, when that is
 * more than it runs at today (Read only on Claude becomes Full on Gemini).
 * Undefined when the switch does not raise it.
 */
export function autonomyRaisedBy(
  from: AgentFamily,
  to: AgentFamily,
  level: AutonomyLevel
): EffectiveAutonomy | undefined {
  const before = effectiveAutonomy(from, level) ?? 'unenforced'
  const after = effectiveAutonomy(to, level) ?? 'unenforced'
  return rank(after) > rank(before) ? after : undefined
}
