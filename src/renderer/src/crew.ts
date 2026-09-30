import type { AgentFamily, MechClass } from '../../shared/types'
// Forged by scripts/sprite-forge.ts: tight-cropped, right-facing portraits
// (so every mech fills its card the same way) and phosphor wireframes.
import atlas from '../../../assets/mechs/portraits/atlas.png?url'
import marauder from '../../../assets/mechs/portraits/marauder.png?url'
import raven from '../../../assets/mechs/portraits/raven.png?url'
import catapult from '../../../assets/mechs/portraits/catapult.png?url'
import locust from '../../../assets/mechs/portraits/locust.png?url'
import atlasSchematic from '../../../assets/mechs/schematics/atlas.png?url'
import marauderSchematic from '../../../assets/mechs/schematics/marauder.png?url'
import ravenSchematic from '../../../assets/mechs/schematics/raven.png?url'
import catapultSchematic from '../../../assets/mechs/schematics/catapult.png?url'
import locustSchematic from '../../../assets/mechs/schematics/locust.png?url'

export const CREW: Record<
  MechClass,
  { image: string; schematic: string; role: string; code: string }
> = {
  atlas: { image: atlas, schematic: atlasSchematic, role: 'Heavy assault', code: 'ATL' },
  marauder: {
    image: marauder,
    schematic: marauderSchematic,
    role: 'Precision strike',
    code: 'MAR'
  },
  raven: { image: raven, schematic: ravenSchematic, role: 'Reconnaissance', code: 'RVN' },
  catapult: {
    image: catapult,
    schematic: catapultSchematic,
    role: 'Visual analysis',
    code: 'CPL'
  },
  locust: { image: locust, schematic: locustSchematic, role: 'Fast courier', code: 'LCT' }
}

export const RUNTIME_NAMES: Record<AgentFamily, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi',
  gemini: 'Gemini',
  hermes: 'Custom CLI'
}
