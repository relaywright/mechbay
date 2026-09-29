/**
 * MechBay sound effects — public contract.
 *
 * Every sound is synthesized at runtime with the Web Audio API (no audio
 * files ship with the app). Callers only ever use the `sfx` singleton below;
 * the engine owns the AudioContext, voice limiting, and the master mix.
 *
 * The AudioContext is created lazily on first use, so importing this module
 * is free, and every call is a silent no-op where Web Audio is unavailable.
 * Sound design lives in patches.ts; rendering in engine.ts.
 */
import { createSfxEngine } from './engine'

/** One-shot sounds. */
export type SfxId =
  // Interface
  | 'ui-click'
  | 'ui-hover'
  | 'ui-tab'
  | 'ui-open'
  | 'ui-close'
  | 'ui-error'
  // Command
  | 'select'
  | 'acknowledge'
  | 'radio'
  | 'target-lock'
  // Mech movement
  | 'footstep-heavy'
  | 'footstep-medium'
  | 'footstep-light'
  | 'servo'
  | 'power-up'
  | 'land'
  // Outcomes
  | 'complete'
  | 'fail'
  | 'explosion'

/** Continuous sounds started/stopped by key. */
export type LoopId = 'ambient' | 'work'

export interface PlayOptions {
  /** 0..1 multiplier on this sound's own level (default 1). */
  volume?: number
  /** Playback-rate / pitch multiplier (default 1). */
  rate?: number
  /** Stereo position, -1 (left) .. 1 (right) (default 0). */
  pan?: number
}

export interface SfxEngine {
  play(id: SfxId, opts?: PlayOptions): void
  /** Start a loop under `key` (idempotent per key). */
  startLoop(key: string, id: LoopId, opts?: PlayOptions): void
  stopLoop(key: string): void
  /** Master on/off. Off silences everything, including running loops. */
  setEnabled(enabled: boolean): void
  /** Master volume, 0..1. */
  setVolume(volume: number): void
  /** Resume the AudioContext; call from a user gesture. Safe to call often. */
  unlock(): void
}

export const sfx: SfxEngine = createSfxEngine()
