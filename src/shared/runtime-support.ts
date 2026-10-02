import type { AgentFamily } from './types'

/**
 * Single source of truth for what the author has actually verified. README,
 * the landing page and the app all read from (or are tested against) this
 * table, so support claims cannot drift apart.
 */
export interface RuntimeSupport {
  /** Name used in the README mechs table. */
  label: string
  /** Name used on the landing page roster ("RUNTIME // <siteLabel>"). */
  siteLabel: string
  /** True only for runtimes the author runs and checks before every release. */
  verifiedByAuthor: boolean
  /** Shown wherever the runtime is offered; null when verified. */
  note: string | null
}

const BYO_KEY_NOTE = 'Bring your own key. Not verified by the author.'

export const RUNTIME_SUPPORT: Record<AgentFamily, RuntimeSupport> = {
  claude: { label: 'Claude Code', siteLabel: 'Claude Code', verifiedByAuthor: true, note: null },
  codex: { label: 'Codex', siteLabel: 'Codex', verifiedByAuthor: true, note: null },
  kimi: {
    label: 'Kimi via Fireworks AI',
    siteLabel: 'Kimi',
    verifiedByAuthor: false,
    note: BYO_KEY_NOTE
  },
  gemini: { label: 'Gemini CLI', siteLabel: 'Gemini', verifiedByAuthor: false, note: BYO_KEY_NOTE },
  hermes: {
    label: 'Bring your own agent',
    siteLabel: 'Bring your own agent',
    verifiedByAuthor: false,
    note: 'Runs the agent command you configure. Not verified by the author.'
  }
}

export function runtimeSupportNote(family: AgentFamily): string | null {
  return RUNTIME_SUPPORT[family].note
}
