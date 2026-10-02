/**
 * Centralized color + typography tokens for MechBay.
 * BattleTech-inspired ops aesthetic: dark terminal + orange/amber accents.
 */

export const colors = {
  // Backgrounds
  bg: '#0a0a0a',
  bgPanel: '#141615',
  bgPanelDark: '#0a0805',
  bgHud: '#171916',
  overlay: 'rgba(0, 0, 0, 0.75)',

  // Borders
  border: '#2a2a2a',
  borderHud: '#34372e',

  // DeployModal-specific tokens (migrated from hardcoded constants)
  bgPanelDarkAlt: '#0a0805', // was DARK_BG
  borderHudAlt: '#2a2520', // was BORDER_COLOR
  textMutedAlt: '#888', // was TEXT_MUTED
  textDim: '#666', // was TEXT_DIM
  statusFailedLight: '#ff6b6b', // lighter shade for failed status
  statusFailedDark: '#c44', // darker shade for failed borders

  // Brand colors
  orange: '#efa54b',
  orangeHover: '#ff7a1a',
  orangeGlow: 'rgba(232, 95, 0, 0.4)',
  amber: '#efc36d',
  amberGlow: 'rgba(255, 204, 51, 0.4)',
  amberTint: 'rgba(255, 204, 51, 0.08)',
  cyan: '#91c7bc',
  cyanGlow: 'rgba(0, 240, 255, 0.4)',
  cyanTint: 'rgba(0, 240, 255, 0.08)',
  // Cockpit instruments (MechWarrior HUD green) — matches --phosphor in command.css.
  phosphor: '#7dff9a',

  // Stream colors
  streamStdout: '#9dd98a',
  streamStderr: '#ffaa55',
  streamSystem: '#ffcc33',

  // Text
  textPrimary: '#ecece2',
  textSecondary: '#abb0a3',
  textMuted: '#919687',
  textDark: '#929588',

  // Status colors
  statusQueued: '#ffcc33',
  statusWalking: '#5599ff',
  statusWorking: '#4caf50',
  statusAwaitingInput: '#ff9800',
  statusCompleted: '#888',
  statusFailed: '#ff5252',

  // LED states
  ledGreen: '#0f0',
  ledAmber: '#ffcc33',
  ledRed: '#ff4444'
}

export const type = {
  mono: "'IBM Plex Mono', 'Cascadia Code', monospace",
  sans: "'Barlow', sans-serif",
  labelTracking: '0.15em',
  hudTracking: '0.1em'
}

export const animations = {
  ledPulse: `
    @keyframes ledPulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 4px currentColor; }
      50% { opacity: 0.6; box-shadow: 0 0 12px currentColor; }
    }
    @media (prefers-reduced-motion: reduce) {
      @keyframes ledPulse {
        0%, 100% { opacity: 1; box-shadow: 0 0 4px currentColor; }
      }
    }
  `,
  pulseWorking: `
    @keyframes pulseWorking {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(0.85); }
    }
    @media (prefers-reduced-motion: reduce) {
      @keyframes pulseWorking {
        0%, 100% { opacity: 1; transform: scale(1); }
      }
    }
  `,
  pulseLed: `
    @keyframes pulseLed {
      0%, 100% { box-shadow: 0 0 4px currentColor; }
      50% { box-shadow: 0 0 12px currentColor; }
    }
    @media (prefers-reduced-motion: reduce) {
      @keyframes pulseLed {
        0%, 100% { box-shadow: 0 0 4px currentColor; }
      }
    }
  `
}
