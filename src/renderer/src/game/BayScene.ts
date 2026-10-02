import Phaser from 'phaser'
import type { AppState, Deployment, FacilityType, MechClass } from '../../../shared/types'
import { bus } from '../bus'
import { colors, type } from '../theme'
import { sfx } from '../audio/sfx'
import { computeServiceRecord } from '../service-record'
import {
  computeFacingFlipX,
  computeGait,
  GAITS,
  stereoPan,
  walkDurationMs,
  type GaitProfile
} from './bay-animation'
import { canvasPointToPage } from './bay-layout'
import { computeDeploymentActions } from './deployment-transitions'
import { deckTile, conduitPath, clampZoom, clampPan, panBounds } from './bay-environment'
import { FX, generateFxTextures } from './fx-textures'
import { Minimap, type MinimapBlip } from './minimap'
import { headingFromDelta } from '../cockpit'
import { textResolutionForZoom } from './text-resolution'

import atlasSheetUrl from '../../../../assets/mechs/sheets/atlas.png?url'
import marauderSheetUrl from '../../../../assets/mechs/sheets/marauder.png?url'
import ravenSheetUrl from '../../../../assets/mechs/sheets/raven.png?url'
import catapultSheetUrl from '../../../../assets/mechs/sheets/catapult.png?url'
import locustSheetUrl from '../../../../assets/mechs/sheets/locust.png?url'

import securityBayUrl from '../../../../assets/facilities/security-bay-poc.png?url'
import researchLabUrl from '../../../../assets/facilities/research-lab-poc.png?url'
import foundryUrl from '../../../../assets/facilities/foundry-poc.png?url'
import commandCenterUrl from '../../../../assets/facilities/command-center-poc.png?url'
import salvageDockUrl from '../../../../assets/facilities/salvage-dock-poc.png?url'
import dataArchiveUrl from '../../../../assets/facilities/data-archive-poc.png?url'

import groundTileUrl from '../../../../assets/ground-tile-poc.png?url'

const TILE_W = 128
const TILE_H = 64
const GRID_W = 16
const GRID_H = 16
const DROP_RADIUS = 100

interface DemoBayLayout {
  mechs: Record<string, { x: number; y: number }>
  facilities: Record<string, { x: number; y: number }>
  updatedAt: number
}

declare global {
  interface Window {
    __mechbayBayLayout?: DemoBayLayout
    __mechbayState?: AppState
  }
}

/**
 * Logical design viewport the camera framing was tuned against, and the
 * camera zoom at that framing. The Phaser game is actually created at
 * (BASE_VIEW × renderScale) so the canvas renders at the window's true
 * device-pixel resolution (see applyResolution) — the zoom scales by the
 * same factor so the world framing stays put while gaining sharpness.
 */
const BASE_VIEW_W = 1100
const BASE_VIEW_H = 640
// Tuned up from 0.52 (Wave 7) so the diamond fills more of the frame — all
// six seeded facilities (including the outermost, (13,3)/(3,13)/(13,13))
// plus their labels still fit comfortably inside the default framing.
const BASE_ZOOM = 0.6

/**
 * Mech sheets come from scripts/sprite-forge.ts: 5 cells of 256×256 (idle,
 * then 4 walk frames), right-facing, feet on a baseline at y=250, each mech
 * already sized by weight class inside its cell. So every frame of every
 * mech displays at one fixed size with its origin on the feet — the sprite's
 * position IS where it stands on the deck.
 */
const MECH_CELL = 256
const MECH_CELL_DISPLAY = 128
const MECH_FEET_ORIGIN_Y = 250 / 256
const MECH_IDLE_FRAME = 0
const MECH_WALK_FIRST_FRAME = 1

/** Silhouette height inside a 256 cell — keep in sync with MECH_SPECS in scripts/sprite-forge.ts. */
const MECH_CELL_HEIGHT: Record<MechClass, number> = {
  atlas: 236,
  marauder: 214,
  raven: 214,
  catapult: 190,
  locust: 166
}

/** Contact-shadow width (world px) — broad for assault chassis, narrow for scouts. */
const MECH_SHADOW_W: Record<MechClass, number> = {
  atlas: 80,
  marauder: 64,
  raven: 50,
  catapult: 74,
  locust: 44
}

/** Radio pitch per chassis, so each mech's acknowledgement chirp sounds like its own. */
const MECH_VOICE_RATE: Record<MechClass, number> = {
  atlas: 0.84,
  marauder: 0.94,
  catapult: 1,
  raven: 1.1,
  locust: 1.22
}

const MECH_SHEET_KEY: Record<MechClass, string> = {
  atlas: 'mech-atlas',
  marauder: 'mech-marauder',
  raven: 'mech-raven',
  catapult: 'mech-catapult',
  locust: 'mech-locust'
}

const MECH_SHEET_URL: Record<MechClass, string> = {
  atlas: atlasSheetUrl,
  marauder: marauderSheetUrl,
  raven: ravenSheetUrl,
  catapult: catapultSheetUrl,
  locust: locustSheetUrl
}

const FACILITY_KEY: Record<FacilityType, string> = {
  'security-bay': 'facility-security-bay',
  'research-lab': 'facility-research-lab',
  foundry: 'facility-foundry',
  'command-center': 'facility-command-center',
  'salvage-dock': 'facility-salvage-dock',
  'data-archive': 'facility-data-archive'
}

// Facilities span ~2 tiles wide × ~1.5 tiles tall on the grid.
const FACILITY_DISPLAY_W = 224
const FACILITY_DISPLAY_H = 168

/**
 * Living details painted into specific facility art, in SOURCE-image pixels
 * of the 1200×896 facility PNGs (converted to world offsets at runtime).
 */
const FACILITY_AMBIENCE: Partial<
  Record<FacilityType, { smoke?: Array<[number, number]>; beacon?: [number, number] }>
> = {
  foundry: {
    smoke: [
      [818, 150],
      [888, 150]
    ]
  },
  'command-center': { beacon: [595, 75] }
}
const FACILITY_SOURCE_W = 1200
const FACILITY_SOURCE_H = 896

/** Depth for overlays that must read above every mech and building. */
const OVERLAY_DEPTH = 5000

const hex = (value: string): number => Phaser.Display.Color.HexStringToColor(value).color
const AMBER = hex(colors.amber)
const CYAN = hex(colors.cyan)
const RED = hex(colors.statusFailed)
const READY_GREEN = 0xb2ce8c
/** Cockpit-instrument green (MechWarrior HUD): targeting, nav, radar. */
const PHOSPHOR = hex(colors.phosphor)

function isoToScreen(tile: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (tile.x - tile.y) * (TILE_W / 2),
    y: (tile.x + tile.y) * (TILE_H / 2)
  }
}

function screenToIso(world: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(world.x / TILE_W + world.y / TILE_H),
    y: Math.round(world.y / TILE_H - world.x / TILE_W)
  }
}

function mechHeight(mechClass: MechClass): number {
  return MECH_CELL_HEIGHT[mechClass] * (MECH_CELL_DISPLAY / MECH_CELL)
}

/** Particle rotation op: point a spark streak along its current velocity. */
function sparkHeading(particle?: Phaser.GameObjects.Particles.Particle): number {
  if (!particle) return 0
  return Phaser.Math.RadToDeg(Math.atan2(particle.velocityY, particle.velocityX))
}

/** Distance (px) a pointer must move between down + up to count as a drag. */
const CLICK_DRAG_THRESHOLD = 8

type StatusMarkerKind = 'awaiting-input' | 'queued'

/**
 * Phaser scene for the isometric mech bay: a 16×16 iso grid rendered in 3/4
 * projection with 128×64 diamond tiles. Real sprites load via Vite `?url`
 * imports; every effect texture is generated at runtime (fx-textures.ts).
 */
export class BayScene extends Phaser.Scene {
  private state: AppState | null = null
  private demoLayoutEnabled = false
  private demoLayoutSignature = ''
  private mechSprites = new Map<string, Phaser.GameObjects.Image>()
  private mechShadows = new Map<string, Phaser.GameObjects.Image>()
  private facilitySprites = new Map<string, Phaser.GameObjects.Image>()
  private facilityLabels = new Map<string, Phaser.GameObjects.Text>()
  private smokeEmitters = new Map<string, Phaser.GameObjects.Particles.ParticleEmitter>()
  private crackleTimers = new Map<string, Phaser.Time.TimerEvent>()
  private damageLights = new Map<string, Phaser.GameObjects.Image>()
  private unavailableLabels = new Map<string, Phaser.GameObjects.Text>()
  private completionBubbles = new Set<Phaser.GameObjects.Container>()

  // --- Animation-pass state. Every Map/ref here is torn down in shutdown()
  // AND in render()'s entity-removal sweep, mirroring the cleanup pattern
  // used for smokeEmitters/unavailableLabels above.
  private reducedMotion = false
  private selectedCompanionId: string | null = null
  private hoveredCompanionId: string | null = null
  private selectionRing: Phaser.GameObjects.Graphics | null = null
  private selectionRingTween: Phaser.Tweens.Tween | null = null
  private idleBreathTweens = new Map<string, Phaser.Tweens.Tween>()
  private workingSwayTweens = new Map<string, Phaser.Tweens.Tween>()
  private squashTweens = new Map<string, Phaser.Tweens.Tween>()
  private footDustEmitters = new Map<string, Phaser.GameObjects.Particles.ParticleEmitter>()
  private workLights = new Map<string, Phaser.GameObjects.Image>()
  private workLightTweens = new Map<string, Phaser.Tweens.Tween>()
  private weldTimers = new Map<string, Phaser.Time.TimerEvent>()
  private holoRings = new Map<
    string,
    { container: Phaser.GameObjects.Container; tweens: Phaser.Tweens.Tween[] }
  >()
  private facilityBeacons = new Map<string, Phaser.GameObjects.Image>()
  private facilityAmbience = new Map<string, Phaser.GameObjects.GameObject[]>()
  private facilityBeaconTweens = new Map<string, Phaser.Tweens.Tween>()
  private activeWalks = new Map<
    string,
    {
      tween: Phaser.Tweens.Tween
      promise: Promise<void>
      resolve: () => void
      cancelled: boolean
    }
  >()

  // --- RTS read-outs: hover/selection glow, unit plates, status markers.
  private glows = new Map<Phaser.GameObjects.Image, Phaser.FX.Glow>()
  private unitPlates = new Map<string, Phaser.GameObjects.Container>()
  private statusMarkers = new Map<
    string,
    {
      kind: StatusMarkerKind
      container: Phaser.GameObjects.Container
      tween: Phaser.Tweens.Tween | null
    }
  >()

  // --- Drag-to-deploy targeting.
  private dragTargetFacilityId: string | null = null
  private dragTether: Phaser.GameObjects.Graphics | null = null
  private dragBrackets = new Map<string, Phaser.GameObjects.Graphics>()

  // --- Living-bay environment layer. Static per-layer Graphics built once
  // (or rebuilt only when the entity set they depend on changes), never
  // redrawn per-frame.
  private hangarPads = new Map<string, Phaser.GameObjects.Graphics>()
  private facilityFoundations = new Map<string, Phaser.GameObjects.Graphics>()
  private conduitsLayer: Phaser.GameObjects.Graphics | null = null
  private conduitSignature = ''
  private conduitPathPoints = new Map<string, Array<{ x: number; y: number }>>()
  private conduitPackets = new Map<string, Phaser.GameObjects.Image>()
  private conduitPacketTweens = new Map<string, Phaser.Tweens.Tween>()
  private apronLayer: Phaser.GameObjects.Graphics | null = null
  private rimLights: Phaser.GameObjects.Image[] = []
  private rimLightTweens: Phaser.Tweens.Tween[] = []
  private hazeEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null
  private searchlights: Phaser.GameObjects.Image[] = []
  private searchlightTweens: Phaser.Tweens.Tween[] = []
  private radar: {
    container: Phaser.GameObjects.Container
    rings: Phaser.GameObjects.Graphics
    tween: Phaser.Tweens.Tween | null
    hubId: string | null
  } | null = null

  // --- Deploy cinematics: target reticle, marching route line, and working
  // data-link, all keyed by companion id and torn down at the same
  // lifecycle points as the effects above.
  private walkReticles = new Map<
    string,
    {
      ring: Phaser.GameObjects.Graphics
      tween: Phaser.Tweens.Tween | null
      label: Phaser.GameObjects.Text | null
    }
  >()
  private routeLines = new Map<
    string,
    { g: Phaser.GameObjects.Graphics; from: { x: number; y: number }; to: { x: number; y: number } }
  >()
  private dataLinks = new Map<
    string,
    {
      facilityId: string
      line: Phaser.GameObjects.Graphics
      packets: Phaser.GameObjects.Image[]
      tweens: Phaser.Tweens.Tween[]
    }
  >()
  /** Short-lived, self-destroying GameObjects (shockwaves, bursts, pillars)
   * that still need tracking so a mid-animation shutdown doesn't leak them. */
  private transientEffects = new Set<Phaser.GameObjects.GameObject>()

  // --- Camera zoom/pan, composed on top of the resolution-derived
  // BASE_ZOOM * renderScale in applyCameraTransform().
  private userZoom = 1
  private userPan = { x: 0, y: 0 }
  private isPanningCamera = false
  private isMinimapDrag = false
  private panPointerStart = { x: 0, y: 0 }
  private panStart = { x: 0, y: 0 }
  private handleResetView = (): void => this.resetView()
  private minimap: Minimap | null = null

  constructor() {
    super('BayScene')
  }

  setState(state: AppState): void {
    const prev = this.state
    this.state = state
    if (this.demoLayoutEnabled) window.__mechbayState = state
    const nextReduceMotion = this.resolveReduceMotion()
    if (this.scene.isActive()) {
      // Apply a live toggle to existing entities before render() runs — new
      // sprites created below already read the up-to-date flag themselves.
      if (nextReduceMotion !== this.reducedMotion) this.setReducedMotion(nextReduceMotion)
      this.render()
    } else {
      // Scene not yet active: create() will read the flag and do the first draw.
      this.reducedMotion = nextReduceMotion
    }
    if (prev) this.reactToDeploymentTransitions(prev, state)
  }

  /** The user's in-app motion preference (defaults to full motion). */
  private resolveReduceMotion(): boolean {
    return this.state?.settings.reduceMotion ?? false
  }

  /**
   * Apply a live change to the reduce-motion preference without reloading the
   * scene. Newly created sprites always read `this.reducedMotion` at creation,
   * so this only has to reconcile the always-on decorative loops for entities
   * that already exist. Per-deploy effects (gait, dust, shake, sparks) read
   * the flag when they're triggered, so they self-correct on the next deploy.
   */
  private setReducedMotion(next: boolean): void {
    this.reducedMotion = next
    if (next) {
      // Motion off: tear down decorative loops and snap transforms to rest.
      for (const id of [...this.idleBreathTweens.keys()]) this.killTween(this.idleBreathTweens, id)
      for (const sprite of this.mechSprites.values()) {
        sprite.angle = 0
        sprite.scaleY = this.baseScaleY(sprite)
      }
      for (const id of [...this.footDustEmitters.keys()]) this.stopFootDust(id)
      for (const id of [...this.facilityBeaconTweens.keys()]) {
        this.killTween(this.facilityBeaconTweens, id)
      }
      for (const beacon of this.facilityBeacons.values()) beacon.destroy()
      this.facilityBeacons.clear()
      for (const id of [...this.conduitPacketTweens.keys()]) {
        this.killTween(this.conduitPacketTweens, id)
      }
      for (const packet of this.conduitPackets.values()) packet.destroy()
      this.conduitPackets.clear()
      for (const id of [...this.weldTimers.keys()]) this.stopWelding(id)
      for (const id of [...this.facilityAmbience.keys()]) this.stopFacilityAmbience(id)
      this.teardownRimChase()
      this.teardownAtmosphere()
      this.teardownRadar()
    } else {
      // Motion on: (re)start decorative loops for entities already on screen.
      for (const id of this.mechSprites.keys()) this.startIdleBreath(id)
      this.state?.facilities.forEach((facility, index) => {
        if (this.facilitySprites.has(facility.id) && !this.facilityBeacons.has(facility.id)) {
          this.createFacilityBeacon(facility.id, isoToScreen(facility.tile), index)
        }
      })
      for (const [id, points] of this.conduitPathPoints) {
        if (!this.conduitPacketTweens.has(id)) this.startConduitPacket(id, points)
      }
      for (const id of this.workLights.keys()) this.startWelding(id)
      for (const id of this.facilitySprites.keys()) this.startFacilityAmbience(id)
      this.buildRimLights()
      this.buildAtmosphere()
      this.buildRadar()
    }
    for (const [id, link] of this.dataLinks) this.startDataLink(id, link.facilityId)
    for (const [facilityId] of [...this.holoRings]) {
      this.stopHoloRing(facilityId)
      this.startHoloRing(facilityId)
    }
    // Redraw the selection ring so its pulse (or lack of one) matches the mode.
    if (this.selectedCompanionId) {
      this.destroySelectionRing()
      this.createSelectionRing(this.selectedCompanionId)
    }
    this.syncStatusMarkers(true)
  }

  preload(): void {
    // Loud asset-load failures — silent fallbacks to Phaser's green __DEFAULT
    // texture tile into a hexagon pattern and are very confusing.
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      console.error(`[BayScene] asset failed to load: ${file.key} → ${file.url}`)
    })

    this.load.image('ground', groundTileUrl)

    for (const mechClass of Object.keys(MECH_SHEET_KEY) as MechClass[]) {
      this.load.spritesheet(MECH_SHEET_KEY[mechClass], MECH_SHEET_URL[mechClass], {
        frameWidth: MECH_CELL,
        frameHeight: MECH_CELL
      })
    }

    this.load.image('facility-security-bay', securityBayUrl)
    this.load.image('facility-research-lab', researchLabUrl)
    this.load.image('facility-foundry', foundryUrl)
    this.load.image('facility-command-center', commandCenterUrl)
    this.load.image('facility-salvage-dock', salvageDockUrl)
    this.load.image('facility-data-archive', dataArchiveUrl)
  }

  create(): void {
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this)
    // Motion is driven by the user's in-app preference, NOT the OS
    // prefers-reduced-motion setting — the animated bay is the whole point,
    // and Windows commonly reports "reduce" (animation effects off) for users
    // who very much want to watch their mechs walk. Live-toggled via setState.
    this.reducedMotion = this.resolveReduceMotion()
    this.cameras.main.setBackgroundColor('#101510')
    this.input.mouse?.disableContextMenu()
    // Frame the bay and match the camera zoom to the render resolution. Also
    // re-run it whenever the canvas is resized (window maximize, HiDPI change)
    // so the world stays centered and crisp — re-centering on every resize is
    // what keeps Scale drift (the "bay slowly scrolls up" bug) from creeping in.
    this.applyResolution()
    this.scale.on(Phaser.Scale.Events.RESIZE, this.applyResolution, this)
    generateFxTextures(this)
    this.applyPostFx()
    this.drawGround()
    this.buildApron()
    this.buildRimLights()
    this.buildAtmosphere()
    if (this.state) this.render()

    this.minimap = new Minimap(
      this,
      [
        isoToScreen({ x: -0.5, y: -0.5 }),
        isoToScreen({ x: GRID_W - 0.5, y: -0.5 }),
        isoToScreen({ x: GRID_W - 0.5, y: GRID_H - 0.5 }),
        isoToScreen({ x: -0.5, y: GRID_H - 0.5 })
      ],
      () => this.reducedMotion
    )

    bus.on('bayResetView', this.handleResetView)
    this.setupCameraControls()

    void window.mechbay
      .getAppMode()
      .then(({ demo }) => {
        if (!demo) return
        this.demoLayoutEnabled = true
        if (this.state) window.__mechbayState = this.state
        this.publishDemoLayout()
      })
      .catch((error) => console.warn('[BayScene] Could not resolve app mode:', error))

    // Scene-level pointerup fires for every release, including those
    // landing on interactive sprites (mechs / facilities). We only want
    // the empty-tile handler when: (a) no interactive object was under
    // the pointer, (b) the pointer barely moved (so drags don't masquerade
    // as clicks on release), and (c) the press wasn't on the minimap.
    this.input.on(
      'pointerup',
      (pointer: Phaser.Input.Pointer, currentlyOver: Phaser.GameObjects.GameObject[]) => {
        if (pointer.button === 2) return
        if (currentlyOver.length > 0) return
        if (this.minimap?.contains({ x: pointer.downX, y: pointer.downY })) return
        const dragDist = Math.hypot(pointer.upX - pointer.downX, pointer.upY - pointer.downY)
        if (dragDist > CLICK_DRAG_THRESHOLD) return

        const tile = screenToIso({ x: pointer.worldX, y: pointer.worldY })
        if (tile.x < 0 || tile.x >= GRID_W || tile.y < 0 || tile.y >= GRID_H) return

        // Guard: don't fire on tiles already occupied by a facility —
        // those are selected via their sprite's own pointerup handler,
        // not via empty-tile click.
        if (this.state?.facilities.some((f) => f.tile.x === tile.x && f.tile.y === tile.y)) {
          return
        }

        bus.emit('emptyTileClicked', { tile })
      }
    )
  }

  /**
   * Keep the world framing identical across displays while rendering at the
   * canvas's true device-pixel resolution. The Phaser game is created at
   * (BASE_VIEW × renderScale), so the WebGL backing store matches the real
   * pixels of a large or HiDPI window instead of a fixed 1100×640 raster that
   * Scale.FIT then upscales into blur. Because the viewport grew by
   * renderScale, the camera zoom grows by the same factor to show the exact
   * same slice of the world — text and sprites gain resolution, the framing
   * does not move.
   */
  private applyResolution(): void {
    this.applyCameraTransform()
    this.minimap?.layout()
  }

  /**
   * Compose the render-resolution zoom (BASE_ZOOM * renderScale, see
   * applyResolution's doc comment above) with the user's mouse-wheel zoom
   * and drag-pan, and re-center. Called on every RESIZE (keeps the
   * anti-drift re-centering intact) AND on every user zoom/pan change, so
   * the two never fight over the camera transform.
   */
  private applyCameraTransform(): void {
    const renderScale = this.scale.gameSize.width / BASE_VIEW_W
    const zoom = BASE_ZOOM * renderScale * this.userZoom
    this.cameras.main.setZoom(zoom)
    this.syncLabelResolution(zoom)
    // Center on the geometric middle of the 16×16 iso diamond, offset by the
    // user's pan. Center tile is (GRID_W/2, GRID_H/2), which iso-maps to
    // (0, GRID_H*TILE_H/2).
    const center = isoToScreen({ x: GRID_W / 2, y: GRID_H / 2 })
    this.cameras.main.centerOn(center.x + this.userPan.x, center.y + this.userPan.y)
  }

  /** Re-rasterize world-space labels at the camera's zoom (see text-resolution.ts). */
  private syncLabelResolution(zoom: number): void {
    const resolution = textResolutionForZoom(zoom)
    for (const label of [...this.facilityLabels.values(), ...this.unavailableLabels.values()]) {
      if (label.style.resolution !== resolution) label.setResolution(resolution)
    }
  }

  /**
   * Camera-wide finish: a soft vignette pulls the eye to the middle of the
   * deck. WebGL only — the canvas renderer has no post pipeline, and the bay
   * simply renders without it there.
   */
  private applyPostFx(): void {
    if (this.game.renderer.type !== Phaser.WEBGL) return
    this.cameras.main.postFX.addVignette(0.5, 0.5, 0.95, 0.3)
  }

  /**
   * Mouse-wheel zoom toward the cursor, left-drag panning on empty ground,
   * and minimap click/drag to jump the view. A drag that starts on an
   * interactive sprite (mech/facility) is left entirely to Phaser's own
   * draggable system — we only start a camera pan when pointerdown lands on
   * nothing (`currentlyOver.length === 0`), same guard the empty-tile click
   * handler uses.
   */
  private setupCameraControls(): void {
    this.input.on(
      'wheel',
      (pointer: Phaser.Input.Pointer, _objects: unknown, _dx: number, dy: number) => {
        const camera = this.cameras.main
        const before = camera.getWorldPoint(pointer.x, pointer.y)
        const nextZoom = clampZoom(this.userZoom - Math.sign(dy) * 0.1)
        if (nextZoom === this.userZoom) return
        this.userZoom = nextZoom
        this.userPan = clampPan(this.userPan, panBounds(this.userZoom, BASE_VIEW_W, BASE_VIEW_H))
        this.applyCameraTransform()

        // Re-derive the world point under the cursor at the new zoom and
        // nudge pan by the difference, so the point the user was hovering
        // stays fixed on screen instead of the zoom recentering on the diamond.
        const after = camera.getWorldPoint(pointer.x, pointer.y)
        this.userPan = clampPan(
          { x: this.userPan.x + (before.x - after.x), y: this.userPan.y + (before.y - after.y) },
          panBounds(this.userZoom, BASE_VIEW_W, BASE_VIEW_H)
        )
        this.applyCameraTransform()
      }
    )

    this.input.on(
      'pointerdown',
      (pointer: Phaser.Input.Pointer, currentlyOver: Phaser.GameObjects.GameObject[]) => {
        if (pointer.button !== 0) return
        if (this.minimap?.contains(pointer)) {
          this.isMinimapDrag = true
          this.panCameraToMinimapPoint(pointer)
          sfx.play('ui-click')
          return
        }
        if (currentlyOver.length > 0) return
        this.isPanningCamera = true
        this.panPointerStart = { x: pointer.x, y: pointer.y }
        this.panStart = { ...this.userPan }
      }
    )

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (this.isMinimapDrag && pointer.isDown) {
        this.panCameraToMinimapPoint(pointer)
        return
      }
      if (!this.isPanningCamera || !pointer.isDown) return
      const zoom = this.cameras.main.zoom
      const dx = (pointer.x - this.panPointerStart.x) / zoom
      const dy = (pointer.y - this.panPointerStart.y) / zoom
      // Dragging the pointer toward +x should slide the world toward +x under
      // it, which means the camera's center moves toward -x — subtract, not add.
      const pan = { x: this.panStart.x - dx, y: this.panStart.y - dy }
      this.userPan = clampPan(pan, panBounds(this.userZoom, BASE_VIEW_W, BASE_VIEW_H))
      this.applyCameraTransform()
    })

    this.input.on('pointerup', () => {
      this.isPanningCamera = false
      this.isMinimapDrag = false
    })
  }

  /** Center the main camera on the world point under a minimap pointer. */
  private panCameraToMinimapPoint(pointer: Phaser.Input.Pointer): void {
    if (!this.minimap) return
    const world = this.minimap.worldPointAt(pointer)
    const center = isoToScreen({ x: GRID_W / 2, y: GRID_H / 2 })
    this.userPan = clampPan(
      { x: world.x - center.x, y: world.y - center.y },
      panBounds(this.userZoom, BASE_VIEW_W, BASE_VIEW_H)
    )
    this.applyCameraTransform()
  }

  /** Animate the camera back to the default framing (RECENTER control). */
  private resetView(): void {
    const proxy = { zoom: this.userZoom, panX: this.userPan.x, panY: this.userPan.y }
    this.tweens.add({
      targets: proxy,
      zoom: 1,
      panX: 0,
      panY: 0,
      duration: 400,
      ease: 'Sine.easeInOut',
      onUpdate: () => {
        this.userZoom = proxy.zoom
        this.userPan = { x: proxy.panX, y: proxy.panY }
        this.applyCameraTransform()
      }
    })
  }

  /**
   * Per-frame hook. Only things that must track moving sprites live here:
   * shadows, the selection ring, unit plates, status markers, the minimap,
   * and the marching route lines. Everything else is tween/timer driven.
   */
  update(time: number): void {
    if (this.demoLayoutEnabled) this.publishDemoLayout()

    const overlay = this.overlayScale()
    for (const [id, sprite] of this.mechSprites) {
      const ground = this.groundY(id, sprite)
      const shadow = this.mechShadows.get(id)
      if (shadow) {
        // The body rises between footfalls; the shadow stays on the deck and
        // tightens slightly as the mech lifts.
        const lift = Math.max(0, ground - sprite.y)
        const base = (shadow.getData('baseScale') as number | undefined) ?? 1
        shadow.setPosition(sprite.x, ground).setScale(base * (1 - lift / 40))
        shadow.setDepth(sprite.depth - 0.5)
      }
      const mechClass = sprite.getData('mechClass') as MechClass
      const plate = this.unitPlates.get(id)
      if (plate) {
        const intro = (plate.getData('intro') as number | undefined) ?? 1
        plate.setPosition(sprite.x, sprite.y - mechHeight(mechClass) - 8)
        plate.setScale(overlay, overlay * intro)
      }
      const marker = this.statusMarkers.get(id)
      if (marker) {
        marker.container.setScale(overlay)
        marker.container.x = sprite.x
        // The awaiting-input marker bobs via its own tween on an offset.
        const bob = (marker.container.getData('bob') as number | undefined) ?? 0
        marker.container.y = sprite.y - mechHeight(mechClass) - 16 * overlay - bob
      }
    }

    if (this.selectedCompanionId && this.selectionRing) {
      const sprite = this.mechSprites.get(this.selectedCompanionId)
      if (sprite) {
        this.selectionRing.setPosition(sprite.x, this.groundY(this.selectedCompanionId, sprite))
        this.selectionRing.setDepth(Math.max(1, sprite.depth - 1))
      }
    }

    if (!this.reducedMotion) {
      for (const [, route] of this.routeLines) this.drawRoute(route.g, route.from, route.to, time)
    }

    this.updateMinimap(time)
  }

  /**
   * World-space scale that keeps HUD-style overlays (unit plates, status
   * markers, bubbles) at a constant on-screen size, however far the camera
   * is zoomed or the window is resized. At the default framing a small
   * window renders world text at under half size, which made them unreadable.
   */
  private overlayScale(): number {
    return Phaser.Math.Clamp(0.85 / this.cameras.main.zoom, 0.6, 3)
  }

  /** Where a mech's feet touch the deck: its y, minus any walk bob in flight. */
  private groundY(companionId: string, sprite: Phaser.GameObjects.Image): number {
    if (!this.activeWalks.has(companionId)) return sprite.y
    return (sprite.getData('groundY') as number | undefined) ?? sprite.y
  }

  private updateMinimap(time: number): void {
    if (!this.minimap || !this.state) return
    const blips: MinimapBlip[] = []
    const workingFacilities = new Set(
      this.state.deployments.filter((d) => d.status === 'working').map((d) => d.facilityId)
    )
    for (const facility of this.state.facilities) {
      const s = isoToScreen(facility.tile)
      blips.push({
        kind: 'facility',
        x: s.x,
        y: s.y,
        color: facility.path ? PHOSPHOR : 0x2f6b3e,
        ring: workingFacilities.has(facility.id)
      })
    }
    for (const companion of this.state.companions) {
      const sprite = this.mechSprites.get(companion.id)
      if (!sprite) continue
      blips.push({
        kind: 'mech',
        x: sprite.x,
        y: this.groundY(companion.id, sprite),
        color: this.mechStatusColor(companion.id),
        ring: companion.id === this.selectedCompanionId
      })
    }
    this.minimap.update(blips, this.cameras.main.worldView, time)
  }

  /** Status colour for a mech from its live deployment (minimap blips, unit plates). */
  private mechStatusColor(companionId: string): number {
    const status = this.activeDeployment(companionId)?.status
    switch (status) {
      case 'walking-to':
      case 'returning':
        return hex(colors.statusWalking)
      case 'working':
        return AMBER
      case 'awaiting-input':
        return hex(colors.statusAwaitingInput)
      case 'queued':
        return 0x9ea991
      case 'failed':
        return RED
      default:
        return READY_GREEN
    }
  }

  /** The companion's newest deployment that still occupies it (or a failure it's stuck in). */
  private activeDeployment(companionId: string): Deployment | undefined {
    return this.state?.deployments.find(
      (d) =>
        d.companionId === companionId &&
        d.status !== 'completed' &&
        d.status !== 'cancelled' &&
        (d.status !== 'failed' || this.smokeEmitters.has(companionId))
    )
  }

  private publishDemoLayout(): void {
    if (!this.demoLayoutEnabled || !this.sys.game.canvas) return

    const camera = this.cameras.main
    const canvasRect = this.sys.game.canvas.getBoundingClientRect()
    const gameSize = this.scale.gameSize
    // Mechs publish their torso rather than their origin (the feet), so
    // automation that presses "on the mech" lands squarely on the sprite.
    const toPage = (sprite: Phaser.GameObjects.Image, localY = 0): { x: number; y: number } => {
      const canvasPoint = Phaser.GameObjects.GetCalcMatrix(sprite, camera).calc.transformPoint(
        0,
        localY
      )
      return canvasPointToPage(canvasPoint, canvasRect, gameSize)
    }
    const mechs = Object.fromEntries(
      [...this.mechSprites].map(([id, sprite]) => [id, toPage(sprite, -MECH_CELL * 0.4)])
    )
    const facilities = Object.fromEntries(
      [...this.facilitySprites].map(([id, sprite]) => [id, toPage(sprite)])
    )
    const signature = JSON.stringify({ mechs, facilities })
    if (signature === this.demoLayoutSignature) return

    this.demoLayoutSignature = signature
    window.__mechbayBayLayout = { mechs, facilities, updatedAt: Date.now() }
  }

  /**
   * Build a small diagonal amber/black stripe texture at runtime — the
   * hazard-tile overlay. Generated once and reused (clipped per-tile by a
   * geometry mask).
   */
  private generateHazardStripeTexture(): void {
    if (this.textures.exists('hazard-stripe')) return
    const size = 32
    const g = this.add.graphics({ x: 0, y: 0 })
    g.fillStyle(0x000000, 1)
    g.fillRect(0, 0, size, size)
    g.lineStyle(6, AMBER, 1)
    for (let offset = -size; offset < size * 2; offset += 12) {
      g.lineBetween(offset, 0, offset + size, size)
    }
    g.generateTexture('hazard-stripe', size, size)
    g.destroy()
  }

  /**
   * Tile the ground diamond across the 16×16 grid. Each tile gets a
   * deterministic tint/alpha from `deckTile` (bay-environment.ts) so the
   * floor reads as worn plated steel instead of a flat repeat, plus a
   * sparse amber/black hazard stripe overlay on the hangar row and outer
   * edge. Overlap at edges is intentional (the orange grid line reads as a
   * unified floor pattern).
   */
  private drawGround(): void {
    this.generateHazardStripeTexture()
    for (let x = 0; x < GRID_W; x++) {
      for (let y = 0; y < GRID_H; y++) {
        const s = isoToScreen({ x, y })
        const tile = deckTile(x, y, GRID_W, GRID_H)
        const baseAlpha = tile.variant === 'grate' ? 0.42 : 0.58
        const shadeChannel = Math.round(200 * tile.shade)
        this.add
          .image(s.x, s.y, 'ground')
          .setDisplaySize(TILE_W, TILE_H)
          .setDepth(0)
          .setAlpha(Math.min(1, baseAlpha * tile.shade))
          .setTint(
            Phaser.Display.Color.GetColor(
              shadeChannel,
              Math.round(shadeChannel * 0.93),
              Math.round(shadeChannel * 0.72)
            )
          )

        if (tile.variant !== 'hazard') continue
        const w = TILE_W * 0.94
        const h = TILE_H * 0.94
        const overlay = this.add
          .image(s.x, s.y, 'hazard-stripe')
          .setDisplaySize(w, h)
          .setDepth(0.5)
          .setAlpha(0.22)
        const maskShape = this.add.graphics()
        maskShape.fillStyle(0xffffff)
        maskShape.fillPoints(
          [
            { x: s.x, y: s.y - h / 2 },
            { x: s.x + w / 2, y: s.y },
            { x: s.x, y: s.y + h / 2 },
            { x: s.x - w / 2, y: s.y }
          ],
          true
        )
        maskShape.setVisible(false)
        overlay.setMask(maskShape.createGeometryMask())
      }
    }
    const perimeter = this.add.graphics().setDepth(1)
    perimeter.lineStyle(2, 0xd1ba72, 0.5)
    const corners = [
      { x: -0.5, y: -0.5 },
      { x: 15.5, y: -0.5 },
      { x: 15.5, y: 15.5 },
      { x: -0.5, y: 15.5 }
    ].map(isoToScreen)
    perimeter.strokePoints(corners, true)
    perimeter.lineStyle(1, 0xbfd292, 0.22)
    for (let i = 2; i < 16; i += 4) {
      const start = isoToScreen({ x: i, y: 0 })
      const end = isoToScreen({ x: i, y: 15 })
      perimeter.lineBetween(start.x, start.y, end.x, end.y)
    }
  }

  /**
   * A faint large-scale grid beyond the diamond, so the field reads as a
   * hangar deck extending past the working area rather than floating in a
   * void. Deliberately no solid fill: Scale.FIT letterboxes the canvas
   * inside a wider frame, and an opaque apron would expose the canvas edge
   * as a hard black box. The camera background matches the panel instead.
   * Built once in create(): it doesn't depend on live state.
   */
  private buildApron(): void {
    const g = this.add.graphics().setDepth(-2)
    g.lineStyle(1, 0x2c3324, 0.12)
    for (let i = -4; i <= GRID_W + 4; i += 4) {
      const a = isoToScreen({ x: i, y: -4 })
      const b = isoToScreen({ x: i, y: GRID_H + 4 })
      g.lineBetween(a.x, a.y, b.x, b.y)
      const c = isoToScreen({ x: -4, y: i })
      const d = isoToScreen({ x: GRID_W + 4, y: i })
      g.lineBetween(c.x, c.y, d.x, d.y)
    }
    this.apronLayer = g
  }

  /**
   * Rim lights along the outer perimeter. Under motion, they chase in
   * sequence (staggered tween delay) like runway edge lighting; under
   * reduced motion they're drawn once at a fixed dim alpha. Rebuildable —
   * called again from setReducedMotion's live-toggle path.
   */
  private buildRimLights(): void {
    if (this.rimLights.length > 0) return
    const perimeterTiles: Array<{ x: number; y: number }> = []
    for (let i = 0; i < GRID_W; i += 2) perimeterTiles.push({ x: i, y: -0.5 })
    for (let i = 0; i < GRID_H; i += 2) perimeterTiles.push({ x: GRID_W - 0.5, y: i })
    for (let i = 0; i < GRID_W; i += 2) perimeterTiles.push({ x: i, y: GRID_H - 0.5 })
    for (let i = 0; i < GRID_H; i += 2) perimeterTiles.push({ x: -0.5, y: i })

    perimeterTiles.forEach((tile, index) => {
      const s = isoToScreen(tile)
      const light = this.add
        .image(s.x, s.y, FX.glow)
        .setTint(AMBER)
        .setScale(0.1, 0.06)
        .setDepth(1)
        .setBlendMode(Phaser.BlendModes.ADD)
      this.rimLights.push(light)
      if (this.reducedMotion) {
        light.setAlpha(0.3)
        return
      }
      light.setAlpha(0.12)
      const tween = this.tweens.add({
        targets: light,
        alpha: 0.95,
        scaleX: 0.16,
        scaleY: 0.09,
        duration: 260,
        delay: index * 90,
        yoyo: true,
        hold: 3200,
        repeat: -1,
        ease: 'Sine.easeInOut'
      })
      this.rimLightTweens.push(tween)
    })
  }

  private teardownRimChase(): void {
    for (const tween of this.rimLightTweens) tween.stop()
    this.rimLightTweens = []
    for (const light of this.rimLights) light.destroy()
    this.rimLights = []
  }

  /**
   * Slow drifting low-alpha haze over the field plus two slow sweeping
   * searchlight cones (additive blend, very low alpha) from opposite
   * corners. Entirely skipped under reduced motion — pure ambience.
   */
  private buildAtmosphere(): void {
    if (this.reducedMotion) return
    if (this.hazeEmitter || this.searchlights.length > 0) return
    const center = isoToScreen({ x: GRID_W / 2, y: GRID_H / 2 })
    this.hazeEmitter = this.add
      .particles(center.x, center.y, FX.puff, {
        x: { min: -900, max: 900 },
        y: { min: -500, max: 500 },
        lifespan: 9000,
        speed: { min: 2, max: 6 },
        angle: { min: 160, max: 200 },
        alpha: { start: 0.09, end: 0 },
        scale: { start: 1.4, end: 2.2 },
        rotate: { min: 0, max: 360 },
        frequency: 650,
        quantity: 1,
        tint: 0x8a9484
      })
      .setDepth(2)

    const origins: Array<[{ x: number; y: number }, number, number]> = [
      [isoToScreen({ x: -3, y: -3 }), 20, 60],
      [isoToScreen({ x: GRID_W + 2, y: GRID_H + 2 }), 200, 240]
    ]
    for (const [origin, angleFrom, angleTo] of origins) {
      const cone = this.add
        .image(origin.x, origin.y, FX.glow)
        .setTint(CYAN)
        .setScale(3.4, 1.1)
        .setOrigin(0.12, 0.5)
        .setAlpha(0.06)
        .setDepth(2)
        .setAngle(angleFrom)
        .setBlendMode(Phaser.BlendModes.ADD)
      this.searchlights.push(cone)
      const tween = this.tweens.add({
        targets: cone,
        angle: angleTo,
        duration: 7000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      })
      this.searchlightTweens.push(tween)
    }
  }

  private teardownAtmosphere(): void {
    this.hazeEmitter?.destroy()
    this.hazeEmitter = null
    for (const tween of this.searchlightTweens) tween.stop()
    this.searchlightTweens = []
    for (const cone of this.searchlights) cone.destroy()
    this.searchlights = []
  }

  /**
   * Tactical radar centred on the command center (or the deck's middle when
   * there isn't one): faint iso range rings plus a slow rotating sweep.
   * The sweep lives inside a container squashed to iso proportions, so the
   * wedge rotates as a flat disc on the deck rather than a spinning ellipse.
   */
  private buildRadar(): void {
    if (this.reducedMotion || !this.state) return
    const hub = this.state.facilities.find((f) => f.facilityType === 'command-center')
    const hubId = hub?.id ?? null
    if (this.radar && this.radar.hubId === hubId) return
    this.teardownRadar()
    const center = isoToScreen(hub?.tile ?? { x: GRID_W / 2, y: GRID_H / 2 })
    const radius = 6 * (TILE_W / 2) * Math.SQRT2

    const rings = this.add.graphics().setDepth(1.5)
    for (const fraction of [1 / 3, 2 / 3, 1]) {
      rings.lineStyle(1, CYAN, fraction === 1 ? 0.14 : 0.08)
      rings.strokeEllipse(center.x, center.y, radius * 2 * fraction, radius * fraction)
    }
    const sweep = this.add
      .image(0, 0, FX.sweep)
      .setDisplaySize(radius * 2, radius * 2)
      .setTint(CYAN)
      .setAlpha(0.1)
      .setBlendMode(Phaser.BlendModes.ADD)
    const container = this.add.container(center.x, center.y, [sweep]).setScale(1, 0.5).setDepth(1.6)
    const tween = this.tweens.add({
      targets: sweep,
      angle: 360,
      duration: 7000,
      repeat: -1,
      ease: 'Linear'
    })
    this.radar = { container, rings, tween, hubId }
  }

  private teardownRadar(): void {
    if (!this.radar) return
    this.radar.tween?.stop()
    this.radar.container.destroy(true)
    this.radar.rings.destroy()
    this.radar = null
  }

  private render(): void {
    if (!this.state) return

    for (const companion of this.state.companions) {
      if (this.mechSprites.has(companion.id)) continue
      this.createMech(companion.id, companion.mechClass, companion.homeTile)
    }

    // Sync NOT DEPLOYABLE overlay with current cliAvailable flag. This
    // re-runs on every setState so the boot CLI check (which updates
    // state async) can flip a mech from unavailable → available without
    // a full scene reload.
    for (const companion of this.state.companions) {
      const sprite = this.mechSprites.get(companion.id)
      if (!sprite) continue
      const hasLabel = this.unavailableLabels.has(companion.id)

      if (!companion.cliAvailable && !hasLabel) {
        sprite.setAlpha(0.45)
        const s = isoToScreen(companion.homeTile)
        const label = this.add
          .text(s.x, s.y + 16, '⚠ NOT DEPLOYABLE', {
            fontSize: '10px',
            color: '#ff4444',
            fontFamily: type.mono,
            fontStyle: 'bold',
            stroke: '#000',
            strokeThickness: 3,
            resolution: textResolutionForZoom(this.cameras.main.zoom)
          })
          .setOrigin(0.5)
          .setDepth(sprite.depth + 1)
        this.unavailableLabels.set(companion.id, label)
      } else if (companion.cliAvailable && hasLabel) {
        sprite.setAlpha(1)
        this.unavailableLabels.get(companion.id)?.destroy()
        this.unavailableLabels.delete(companion.id)
      }
    }

    for (const facility of this.state.facilities) {
      if (!this.facilitySprites.has(facility.id)) {
        this.createFacility(facility.id, facility.facilityType, facility.tile, facility.name)
      }
      this.applyFacilityLinkState(facility.id, Boolean(facility.path))
    }

    // Remove sprites for entities no longer in state (e.g., decommissioned facility)
    for (const [id, sprite] of this.mechSprites) {
      if (!this.state.companions.some((c) => c.id === id)) {
        this.cancelActiveWalk(id)
        this.setGlow(sprite, null)
        sprite.destroy()
        this.mechSprites.delete(id)
        this.mechShadows.get(id)?.destroy()
        this.mechShadows.delete(id)
        this.unavailableLabels.get(id)?.destroy()
        this.unavailableLabels.delete(id)
        this.killTween(this.idleBreathTweens, id)
        this.killTween(this.workingSwayTweens, id)
        this.killTween(this.squashTweens, id)
        this.footDustEmitters.get(id)?.destroy()
        this.footDustEmitters.delete(id)
        this.hangarPads.get(id)?.destroy()
        this.hangarPads.delete(id)
        this.stopDataLink(id)
        this.clearDeadInField(id)
        this.hideUnitPlate(id)
        this.removeStatusMarker(id)
        sfx.stopLoop(`work-${id}`)
        if (this.selectedCompanionId === id) {
          this.selectedCompanionId = null
          this.destroySelectionRing()
        }
        if (this.hoveredCompanionId === id) this.hoveredCompanionId = null
      }
    }
    for (const [id, sprite] of this.facilitySprites) {
      if (!this.state.facilities.some((f) => f.id === id)) {
        this.setGlow(sprite, null)
        sprite.destroy()
        this.facilitySprites.delete(id)
        this.facilityLabels.get(id)?.destroy()
        this.facilityLabels.delete(id)
        this.killTween(this.facilityBeaconTweens, id)
        this.facilityBeacons.get(id)?.destroy()
        this.facilityBeacons.delete(id)
        this.killTween(this.workLightTweens, id)
        this.workLights.get(id)?.destroy()
        this.workLights.delete(id)
        this.stopWelding(id)
        this.stopHoloRing(id)
        this.stopFacilityAmbience(id)
        this.facilityFoundations.get(id)?.destroy()
        this.facilityFoundations.delete(id)
        this.dragBrackets.get(id)?.destroy()
        this.dragBrackets.delete(id)
        for (const [companionId, link] of this.dataLinks) {
          if (link.facilityId === id) this.stopDataLink(companionId)
        }
      }
    }
    this.rebuildConduits()
    this.buildRadar()
    this.syncStatusMarkers(false)
    this.refreshUnitPlates()
    this.publishDemoLayout()
  }

  private createMech(
    companionId: string,
    mechClass: MechClass,
    homeTile: { x: number; y: number }
  ): void {
    const s = isoToScreen(homeTile)

    const shadow = this.add
      .image(s.x, s.y, FX.shadow)
      .setDisplaySize(MECH_SHADOW_W[mechClass], MECH_SHADOW_W[mechClass] * 0.5)
    shadow.setData('baseScale', shadow.scaleX)
    this.mechShadows.set(companionId, shadow)

    const sprite = this.add.image(s.x, s.y, MECH_SHEET_KEY[mechClass], MECH_IDLE_FRAME)
    sprite.setOrigin(0.5, MECH_FEET_ORIGIN_Y)
    sprite.setDisplaySize(MECH_CELL_DISPLAY, MECH_CELL_DISPLAY)
    // setDisplaySize leaves the sprite at a fractional scale. Every scale
    // animation below must stay RELATIVE to this base — tweening toward
    // absolute 1.0 would stretch the mech to full texture size.
    sprite.setData('baseScaleY', sprite.scaleY)
    sprite.setData('mechClass', mechClass)
    this.updateMechDepth(sprite, s.y)
    // Hit area: the silhouette's own bounds inside the cell, not the whole
    // 256² frame, so empty space around a small scout doesn't steal clicks.
    const cellH = MECH_CELL_HEIGHT[mechClass]
    const hitW = Math.min(MECH_CELL, cellH * 0.9)
    sprite.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(
        (MECH_CELL - hitW) / 2,
        MECH_CELL * MECH_FEET_ORIGIN_Y - cellH,
        hitW,
        cellH
      ),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      draggable: true,
      cursor: 'grab'
    })
    this.input.setDraggable(sprite)

    // Track drag start position to distinguish click from drag
    let dragStartX = 0
    let dragStartY = 0
    let isDragging = false

    sprite.on('dragstart', () => {
      dragStartX = sprite.x
      dragStartY = sprite.y
      isDragging = false
      this.killTween(this.idleBreathTweens, companionId)
      sprite.scaleY = this.baseScaleY(sprite)
      this.beginDragTargeting()
      sfx.play('servo', { rate: MECH_VOICE_RATE[mechClass], volume: 0.7 })
    })

    sprite.on('drag', (_p: Phaser.Input.Pointer, dragX: number, dragY: number) => {
      sprite.x = dragX
      sprite.y = dragY
      this.updateMechDepth(sprite)
      // Mark as dragging if moved more than threshold
      if (Math.hypot(dragX - dragStartX, dragY - dragStartY) > CLICK_DRAG_THRESHOLD) {
        isDragging = true
      }
      this.updateDragTargeting(companionId, sprite)
    })

    sprite.on('dragend', () => {
      this.endDragTargeting()
      this.handleDragEnd(companionId, sprite)
      isDragging = false
    })

    // Use pointerup to detect clicks (not pointerdown to avoid drag conflict)
    sprite.on('pointerup', () => {
      // Only emit companionSelected if we didn't drag significantly
      if (!isDragging) {
        bus.emit('companionSelected', { companionId })
        this.setSelectedCompanion(companionId)
      }
    })

    sprite.on('pointerover', () => {
      this.hoveredCompanionId = companionId
      this.refreshMechGlow(companionId)
      this.showUnitPlate(companionId)
    })
    sprite.on('pointerout', () => {
      if (this.hoveredCompanionId === companionId) this.hoveredCompanionId = null
      this.refreshMechGlow(companionId)
      if (this.selectedCompanionId !== companionId) this.hideUnitPlate(companionId)
    })

    this.mechSprites.set(companionId, sprite)
    this.startIdleBreath(companionId)
    this.buildHangarPad(companionId, homeTile)
  }

  private createFacility(
    facilityId: string,
    facilityType: FacilityType,
    tile: { x: number; y: number },
    name: string
  ): void {
    const s = isoToScreen(tile)
    const sprite = this.add.image(s.x, s.y - FACILITY_DISPLAY_H * 0.3, FACILITY_KEY[facilityType])
    sprite.setDisplaySize(FACILITY_DISPLAY_W, FACILITY_DISPLAY_H)
    sprite.setDepth(50 + s.y)
    sprite.setInteractive({ cursor: 'pointer' })
    sprite.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonReleased() || pointer.button === 2) {
        bus.emit('facilityRightClicked', { facilityId })
        return
      }
      sfx.play('ui-click')
      bus.emit('facilityClicked', { facilityId })
    })
    sprite.on('pointerover', () => {
      if (this.dragTargetFacilityId === null) this.setGlow(sprite, AMBER, 3)
      this.facilityLabels.get(facilityId)?.setColor('#ffe3a3')
    })
    sprite.on('pointerout', () => {
      if (this.dragTargetFacilityId !== facilityId) this.setGlow(sprite, null)
      this.applyFacilityLinkState(facilityId, sprite.getData('linked') as boolean)
    })
    this.facilitySprites.set(facilityId, sprite)
    sprite.setData('facilityType', facilityType)
    this.startFacilityAmbience(facilityId)
    this.createFacilityBeacon(
      facilityId,
      s,
      this.state?.facilities.findIndex((f) => f.id === facilityId) ?? 0
    )

    // Facility label below the sprite
    const label = this.add
      .text(s.x, s.y + FACILITY_DISPLAY_H * 0.3, name.toUpperCase(), {
        fontSize: '20px',
        color: '#e9d8a9',
        fontFamily: 'IBM Plex Mono',
        fontStyle: 'normal',
        stroke: '#000',
        strokeThickness: 3,
        resolution: textResolutionForZoom(this.cameras.main.zoom)
      })
      .setOrigin(0.5)
      .setDepth(500)
    this.facilityLabels.set(facilityId, label)
    this.buildFacilityFoundation(facilityId, tile)
  }

  /**
   * Starter buildings that aren't linked to a project directory yet read as
   * dormant: desaturated and dimmer, with a muted label. Linking one brings
   * it to full colour — a small "structure online" moment in RTS terms.
   */
  private applyFacilityLinkState(facilityId: string, linked: boolean): void {
    const sprite = this.facilitySprites.get(facilityId)
    const label = this.facilityLabels.get(facilityId)
    if (!sprite) return
    const wasLinked = sprite.getData('linked') as boolean | undefined
    sprite.setData('linked', linked)
    if (linked) sprite.clearTint()
    else sprite.setTint(0xb9bcae)
    label?.setColor(linked ? '#e9d8a9' : '#8d927f')
    if (wasLinked === false && linked && !this.reducedMotion) this.playStructureOnline(facilityId)
  }

  /** A brief amber scan-flash when a dormant building gets linked. */
  private playStructureOnline(facilityId: string): void {
    const sprite = this.facilitySprites.get(facilityId)
    if (!sprite) return
    const flash = this.add
      .image(sprite.x, sprite.y, FX.glow)
      .setTint(AMBER)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(sprite.depth + 1)
      .setScale(1)
      .setAlpha(0.8)
    this.transientEffects.add(flash)
    this.tweens.add({
      targets: flash,
      scale: 5,
      alpha: 0,
      duration: 700,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        this.transientEffects.delete(flash)
        flash.destroy()
      }
    })
    sfx.play('power-up', { volume: 0.6 })
  }

  /**
   * Hover/selection outline. Uses Phaser's WebGL glow pre-FX; a no-op on the
   * canvas renderer (there's no preFX there), where hover still reads via
   * the unit plate and cursor.
   */
  private setGlow(target: Phaser.GameObjects.Image, color: number | null, strength = 2): void {
    const existing = this.glows.get(target)
    if (color === null) {
      if (existing) {
        target.preFX?.remove(existing)
        this.glows.delete(target)
      }
      return
    }
    if (existing) {
      existing.color = color
      existing.outerStrength = strength
      return
    }
    if (!target.preFX) return
    target.preFX.padding = 6
    const glow = target.preFX.addGlow(color, strength, 0, false, 0.1, 10)
    this.glows.set(target, glow)
  }

  /** Selected mechs glow cyan; hovered ones amber; everything else none. */
  private refreshMechGlow(companionId: string): void {
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return
    if (companionId === this.selectedCompanionId) this.setGlow(sprite, CYAN, 1.6)
    else if (companionId === this.hoveredCompanionId) this.setGlow(sprite, AMBER, 2.2)
    else this.setGlow(sprite, null)
  }

  /**
   * Unit plate over a hovered or selected mech: callsign, pilot rank as
   * chevrons, XP toward the next rank, and live status — all derived from
   * real state (service record + deployments), never invented telemetry.
   */
  private showUnitPlate(companionId: string, animate = true): void {
    const companion = this.state?.companions.find((c) => c.id === companionId)
    const sprite = this.mechSprites.get(companionId)
    if (!companion || !sprite || !this.state) return

    const record = computeServiceRecord(companionId, this.state.deployments)
    const deployment = this.activeDeployment(companionId)
    // The main process marks a deployment 'working' the moment it launches,
    // while the mech is still walking out — say what the commander sees.
    const statusText = this.activeWalks.has(companionId)
      ? deployment
        ? 'EN ROUTE'
        : 'RETURNING'
      : deployment
        ? deployment.status.replace(/-/g, ' ').toUpperCase()
        : 'READY'

    // State broadcasts arrive for every log line of a running mission; only
    // rebuild the plate when what it shows has actually changed.
    const signature = [
      companion.name,
      record.rank.tier,
      record.rank.progress.toFixed(3),
      statusText,
      this.mechStatusColor(companionId)
    ].join('|')
    const existing = this.unitPlates.get(companionId)
    if (existing && !animate && existing.getData('signature') === signature) return
    this.hideUnitPlate(companionId)

    const name = this.add
      .text(0, -30, companion.name.toUpperCase(), {
        fontFamily: type.mono,
        fontSize: '15px',
        fontStyle: 'bold',
        color: colors.amber,
        resolution: 2
      })
      .setOrigin(0.5, 0)
    const rank = this.add
      .text(0, -12, `${record.rank.title.toUpperCase()} · ${statusText}`, {
        fontFamily: type.mono,
        fontSize: '12px',
        color: colors.textSecondary,
        resolution: 2
      })
      .setOrigin(0.5, 0)
    const width = Math.max(name.width, rank.width) + 22
    const bg = this.add.graphics()
    bg.fillStyle(hex(colors.bgPanelDark), 0.88)
    bg.fillRect(-width / 2, -36, width, 38)
    bg.lineStyle(1, AMBER, 0.45)
    bg.strokeRect(-width / 2, -36, width, 38)
    // Status tick on the left edge, rank chevrons on the right.
    bg.fillStyle(this.mechStatusColor(companionId), 1)
    bg.fillRect(-width / 2, -36, 3, 38)
    bg.lineStyle(1.5, AMBER, 0.9)
    for (let i = 0; i < record.rank.tier; i++) {
      const cx = width / 2 - 8
      const cy = -30 + i * 4
      bg.lineBetween(cx - 4, cy, cx, cy + 3)
      bg.lineBetween(cx, cy + 3, cx + 4, cy)
    }
    // XP bar along the bottom edge.
    bg.fillStyle(0x2a3024, 1)
    bg.fillRect(-width / 2 + 3, 0, width - 3, 2)
    bg.fillStyle(AMBER, 1)
    bg.fillRect(-width / 2 + 3, 0, (width - 3) * record.rank.progress, 2)

    const plate = this.add
      .container(0, 0, [bg, name, rank])
      .setDepth(OVERLAY_DEPTH)
      .setData('signature', signature)
    const mechClass = sprite.getData('mechClass') as MechClass
    const overlay = this.overlayScale()
    plate.setPosition(sprite.x, sprite.y - mechHeight(mechClass) - 8).setScale(overlay)
    if (animate && !this.reducedMotion) {
      // Unfold vertically from a line; update() applies `intro` on top of
      // the constant-screen-size scale.
      const intro = { v: 0.3 }
      plate.setAlpha(0).setData('intro', intro.v)
      this.tweens.add({
        targets: intro,
        v: 1,
        duration: 150,
        ease: 'Quad.Out',
        onUpdate: () => plate.setData('intro', intro.v).setAlpha(intro.v)
      })
    }
    this.unitPlates.set(companionId, plate)
  }

  private hideUnitPlate(companionId: string): void {
    const plate = this.unitPlates.get(companionId)
    if (!plate) return
    this.tweens.killTweensOf(plate)
    plate.destroy(true)
    this.unitPlates.delete(companionId)
  }

  /** Re-render open plates so rank/status follow state changes. */
  private refreshUnitPlates(): void {
    for (const id of [...this.unitPlates.keys()]) {
      if (id === this.selectedCompanionId || id === this.hoveredCompanionId) {
        this.showUnitPlate(id, false)
      } else {
        this.hideUnitPlate(id)
      }
    }
  }

  /**
   * Status markers above mechs that need the commander: a bobbing amber
   * "!" when a deployment is awaiting input, and a dim QUEUED tag when a
   * mech is assigned but waiting for a free slot. Derived from current
   * state on every render (idempotent), not from transitions.
   */
  private syncStatusMarkers(rebuild: boolean): void {
    if (!this.state) return
    for (const companion of this.state.companions) {
      const status = this.activeDeployment(companion.id)?.status
      const want: StatusMarkerKind | null =
        status === 'awaiting-input' ? 'awaiting-input' : status === 'queued' ? 'queued' : null
      const current = this.statusMarkers.get(companion.id)
      if (current && (current.kind !== want || rebuild)) this.removeStatusMarker(companion.id)
      if (want && (!this.statusMarkers.has(companion.id) || rebuild)) {
        this.createStatusMarker(companion.id, want)
      }
    }
  }

  private createStatusMarker(companionId: string, kind: StatusMarkerKind): void {
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return
    const mechClass = sprite.getData('mechClass') as MechClass
    const top = sprite.y - mechHeight(mechClass) - 16 * this.overlayScale()
    const parts: Phaser.GameObjects.GameObject[] = []
    if (kind === 'awaiting-input') {
      const color = hex(colors.statusAwaitingInput)
      const glow = this.add
        .image(0, 0, FX.glow)
        .setTint(color)
        .setScale(0.7)
        .setAlpha(0.5)
        .setBlendMode(Phaser.BlendModes.ADD)
      const diamond = this.add.graphics()
      diamond.fillStyle(hex(colors.bgPanelDark), 0.95)
      diamond.lineStyle(2, color, 1)
      const pts = [
        { x: 0, y: -13 },
        { x: 13, y: 0 },
        { x: 0, y: 13 },
        { x: -13, y: 0 }
      ]
      diamond.fillPoints(pts, true)
      diamond.strokePoints(pts, true)
      const bang = this.add
        .text(0, 0, '!', {
          fontFamily: type.mono,
          fontSize: '16px',
          fontStyle: 'bold',
          color: colors.statusAwaitingInput,
          resolution: 2
        })
        .setOrigin(0.5)
      parts.push(glow, diamond, bang)
    } else {
      const tag = this.add
        .text(0, 0, 'QUEUED', {
          fontFamily: type.mono,
          fontSize: '11px',
          color: '#c9c09a',
          backgroundColor: 'rgba(10,8,5,0.85)',
          padding: { x: 6, y: 2 },
          resolution: 2
        })
        .setOrigin(0.5)
      parts.push(tag)
    }
    const container = this.add
      .container(sprite.x, top, parts)
      .setDepth(OVERLAY_DEPTH - 1)
      .setScale(this.overlayScale())
    let tween: Phaser.Tweens.Tween | null = null
    if (kind === 'awaiting-input' && !this.reducedMotion) {
      const bob = { v: 0 }
      tween = this.tweens.add({
        targets: bob,
        v: 7,
        duration: 520,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        onUpdate: () => container.setData('bob', bob.v)
      })
    }
    this.statusMarkers.set(companionId, { kind, container, tween })
  }

  private removeStatusMarker(companionId: string): void {
    const marker = this.statusMarkers.get(companionId)
    if (!marker) return
    marker.tween?.stop()
    marker.container.destroy(true)
    this.statusMarkers.delete(companionId)
  }

  /** While a mech is dragged: faint brackets on every facility as drop targets. */
  private beginDragTargeting(): void {
    this.dragTargetFacilityId = null
    this.dragTether?.destroy()
    this.dragTether = this.add.graphics().setDepth(3)
    for (const [facilityId, sprite] of this.facilitySprites) {
      const g = this.add
        .graphics()
        .setPosition(sprite.x, sprite.y)
        .setDepth(sprite.depth + 1)
      this.drawBrackets(g, FACILITY_DISPLAY_W * 0.42, PHOSPHOR, 0.28)
      this.dragBrackets.set(facilityId, g)
    }
  }

  /**
   * Track the nearest facility within drop range: lock-on brackets and a
   * glow on the target, a tether from the mech's hangar pad to the cursor,
   * and a target-lock chirp each time the target changes.
   */
  private updateDragTargeting(companionId: string, sprite: Phaser.GameObjects.Image): void {
    if (!this.state) return
    const target = this.state.facilities.find((f) => {
      const s = isoToScreen(f.tile)
      return Math.hypot(sprite.x - s.x, sprite.y - s.y) < DROP_RADIUS
    })
    const nextId = target?.id ?? null
    if (nextId !== this.dragTargetFacilityId) {
      const prev = this.dragTargetFacilityId
        ? this.facilitySprites.get(this.dragTargetFacilityId)
        : null
      if (prev) this.setGlow(prev, null)
      if (this.dragTargetFacilityId) {
        const g = this.dragBrackets.get(this.dragTargetFacilityId)
        if (g) this.drawBrackets(g, FACILITY_DISPLAY_W * 0.42, PHOSPHOR, 0.28)
      }
      this.dragTargetFacilityId = nextId
      if (nextId) {
        const next = this.facilitySprites.get(nextId)
        if (next) this.setGlow(next, PHOSPHOR, 4)
        const g = this.dragBrackets.get(nextId)
        if (g) this.drawBrackets(g, FACILITY_DISPLAY_W * 0.36, PHOSPHOR, 0.95)
        sfx.play('target-lock', { volume: 0.8 })
      }
    }

    const companion = this.state.companions.find((c) => c.id === companionId)
    if (!companion || !this.dragTether) return
    const home = isoToScreen(companion.homeTile)
    this.dragTether.clear()
    this.drawDashedLine(
      this.dragTether,
      home,
      { x: sprite.x, y: sprite.y },
      AMBER,
      nextId ? 0.75 : 0.35,
      0
    )
  }

  private endDragTargeting(): void {
    if (this.dragTargetFacilityId) {
      const sprite = this.facilitySprites.get(this.dragTargetFacilityId)
      if (sprite) this.setGlow(sprite, null)
    }
    this.dragTargetFacilityId = null
    for (const g of this.dragBrackets.values()) g.destroy()
    this.dragBrackets.clear()
    this.dragTether?.destroy()
    this.dragTether = null
  }

  /** Four corner brackets centred on the graphics object's origin. */
  private drawBrackets(
    g: Phaser.GameObjects.Graphics,
    size: number,
    color: number,
    alpha: number,
    width = 2
  ): void {
    const half = size / 2
    const len = size * 0.26
    g.clear()
    g.lineStyle(width, color, alpha)
    for (const [cx, cy, dx, dy] of [
      [-half, -half, 1, 1],
      [half, -half, -1, 1],
      [half, half, -1, -1],
      [-half, half, 1, -1]
    ]) {
      g.lineBetween(cx, cy, cx + len * dx, cy)
      g.lineBetween(cx, cy, cx, cy + len * dy)
    }
  }

  private handleDragEnd(companionId: string, sprite: Phaser.GameObjects.Image): void {
    if (!this.state) return
    const dropped = this.state.facilities.find((f) => {
      const s = isoToScreen(f.tile)
      return Math.hypot(sprite.x - s.x, sprite.y - s.y) < DROP_RADIUS
    })

    if (dropped) {
      bus.emit('dropOnFacility', { companionId, facilityId: dropped.id })
    }

    // Always snap mech back to home — the deploy flow will walk it to the
    // facility via walkTo() once the deployment transitions to walking-to.
    const companion = this.state.companions.find((c) => c.id === companionId)
    if (!companion) return
    const home = isoToScreen(companion.homeTile)
    this.tweens.add({
      targets: sprite,
      x: home.x,
      y: home.y,
      duration: 300,
      ease: 'Back.easeOut',
      onUpdate: () => this.updateMechDepth(sprite),
      onComplete: () => this.startIdleBreath(companionId)
    })
  }

  /**
   * Walk a mech to a target tile. Resolves when it arrives.
   *
   * Each chassis walks with its own gait (bay-animation.ts GAITS): speed,
   * stride timing, bob, forward lean and per-step roll. Footfalls drive
   * dust, a footstep sound panned to the mech's screen position, a squash,
   * and — for heavy chassis — a small camera shake. A short crouch-and-spool
   * anticipation precedes the first step, and the arrival settles with a
   * landing squash.
   *
   * The position itself is tweened against a plain `{ t }` progress proxy
   * (not the sprite's x/y directly) so the gait pose can be composed on top
   * of the interpolated position in the same onUpdate, rather than running a
   * second tween that would fight the position tween over sprite.y.
   */
  walkTo(
    companionId: string,
    targetTile: { x: number; y: number },
    opts?: { facilityTile?: { x: number; y: number } }
  ): Promise<void> {
    this.cancelActiveWalk(companionId)
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return Promise.resolve()
    const mechClass = (sprite.getData('mechClass') as MechClass | undefined) ?? 'atlas'
    const gait = GAITS[mechClass]
    const target = isoToScreen(targetTile)
    const startX = sprite.x
    const startY = sprite.y

    // Deploy cinematics: a marching amber route line for every walk, plus a
    // target-lock reticle on the facility for walk-to-facility specifically
    // (walk-home has no `facilityTile`, so no reticle).
    this.showRouteLine(companionId, { x: startX, y: startY }, target)
    if (opts?.facilityTile) this.showReticle(companionId, opts.facilityTile)

    sprite.setFlipX(computeFacingFlipX(sprite.flipX, target.x - startX))
    const direction: 1 | -1 = sprite.flipX ? -1 : 1
    if (target.x !== startX || target.y !== startY) {
      this.setMechHeading(companionId, headingFromDelta(target.x - startX, target.y - startY))
    }

    // A mech that's about to walk is no longer idle — stop the breathing
    // loop and reset scaleY so squash tweens always start from the baseline.
    this.killTween(this.idleBreathTweens, companionId)
    this.killTween(this.squashTweens, companionId)
    const base = this.baseScaleY(sprite)
    sprite.scaleY = base
    sprite.setData('groundY', startY)
    this.startFootDust(companionId, sprite)

    const walkDist = Math.hypot(target.x - startX, target.y - startY)
    const walkDuration = walkDurationMs(walkDist, gait)
    const anticipationMs = this.reducedMotion ? 0 : 240
    if (!this.reducedMotion) {
      sfx.play('power-up', {
        volume: 0.45,
        rate: MECH_VOICE_RATE[mechClass],
        pan: this.panFor(startX)
      })
      const crouch = this.tweens.add({
        targets: sprite,
        scaleY: base * (1 - gait.squash * 1.4),
        duration: anticipationMs * 0.6,
        yoyo: true,
        ease: 'Quad.easeOut'
      })
      this.squashTweens.set(companionId, crouch)
    }

    // Frame 0 is the idle pose; everything after it is the walk cycle, so
    // longer forged cycles (e.g. 8 frames) are picked up automatically.
    const walkFrames = Math.max(1, this.textures.get(MECH_SHEET_KEY[mechClass]).frameTotal - 2)
    const progress = { t: 0 }
    let lastStep = 0
    let currentFrame = -1
    let resolveWalk!: () => void
    const promise = new Promise<void>((resolve) => {
      resolveWalk = resolve
    })
    const tween: Phaser.Tweens.Tween = this.tweens.add({
      targets: progress,
      t: 1,
      delay: anticipationMs,
      duration: walkDuration,
      ease: 'Sine.easeInOut',
      onUpdate: (tween) => {
        sprite.x = Phaser.Math.Linear(startX, target.x, progress.t)
        const groundY = Phaser.Math.Linear(startY, target.y, progress.t)
        sprite.setData('groundY', groundY)
        // Depth from the un-bobbed ground position so two mechs at the same
        // tile don't z-fight on the bob oscillation.
        this.updateMechDepth(sprite, groundY)
        if (this.reducedMotion) {
          sprite.y = groundY
          return
        }
        const pose = computeGait(tween.elapsed - anticipationMs, gait, direction, walkFrames)
        if (pose.frame !== currentFrame) {
          currentFrame = pose.frame
          sprite.setFrame(MECH_WALK_FIRST_FRAME + pose.frame)
        }
        sprite.y = groundY + pose.yOffset
        sprite.angle = pose.angleDeg
        if (pose.step !== lastStep) {
          lastStep = pose.step
          this.onFootfall(companionId, sprite, gait, groundY, pose.step)
        }
      },
      onComplete: () => {
        sprite.x = target.x
        sprite.y = target.y
        sprite.angle = 0
        sprite.setFrame(MECH_IDLE_FRAME)
        this.updateMechDepth(sprite, target.y)
        this.stopFootDust(companionId)
        this.playArrival(companionId, sprite, gait)
        this.hideRouteLine(companionId)
        this.hideReticle(companionId, opts?.facilityTile !== undefined)
        if (this.activeWalks.get(companionId)?.tween === tween) {
          this.activeWalks.delete(companionId)
        }
        this.refreshUnitPlates()
        resolveWalk()
      }
    })
    this.activeWalks.set(companionId, {
      tween,
      promise,
      resolve: resolveWalk,
      cancelled: false
    })
    return promise
  }

  /**
   * Remember a mech's compass heading and, if it's the selected mech, feed
   * the cockpit compass tape. A mech that hasn't moved yet faces the way its
   * art does: front-right, down the iso +x axis.
   */
  private setMechHeading(companionId: string, heading: number): void {
    this.mechSprites.get(companionId)?.setData('heading', heading)
    if (companionId === this.selectedCompanionId) bus.emit('mechHeading', { companionId, heading })
  }

  private mechHeading(companionId: string): number {
    const sprite = this.mechSprites.get(companionId)
    const stored = sprite?.getData('heading') as number | undefined
    if (stored !== undefined) return stored
    return headingFromDelta(sprite?.flipX ? -TILE_W / 2 : TILE_W / 2, TILE_H / 2)
  }

  /** Stereo position of a world x within the main camera's current view. */
  private panFor(worldX: number): number {
    const view = this.cameras.main.worldView
    return stereoPan(worldX, view.x, view.width)
  }

  /** One foot hits the deck. */
  private onFootfall(
    companionId: string,
    sprite: Phaser.GameObjects.Image,
    gait: GaitProfile,
    groundY: number,
    step: number
  ): void {
    const side = step % 2 === 0 ? -1 : 1
    const mechClass = sprite.getData('mechClass') as MechClass
    const footX = sprite.x + side * MECH_SHADOW_W[mechClass] * 0.22
    const dust = this.footDustEmitters.get(companionId)
    if (dust) {
      dust.setDepth(Math.max(1, sprite.depth - 1))
      dust.explode(Math.round(3 + gait.dust * 3), footX, groundY)
    }
    sfx.play(gait.footstep, {
      rate: gait.stepRate * (0.96 + (step % 3) * 0.03),
      volume: 0.55,
      pan: this.panFor(sprite.x)
    })
    if (gait.shake > 0 && !this.isPanningCamera) this.cameras.main.shake(110, gait.shake)

    const base = this.baseScaleY(sprite)
    this.killTween(this.squashTweens, companionId)
    sprite.scaleY = base * (1 - gait.squash)
    const recover = this.tweens.add({
      targets: sprite,
      scaleY: base,
      duration: gait.stepMs * 0.4,
      ease: 'Quad.easeOut'
    })
    this.squashTweens.set(companionId, recover)
  }

  private cancelActiveWalk(companionId: string): void {
    const activeWalk = this.activeWalks.get(companionId)
    if (!activeWalk) return
    activeWalk.cancelled = true
    activeWalk.tween.stop()
    this.activeWalks.delete(companionId)
    this.stopFootDust(companionId)
    this.hideRouteLine(companionId)
    this.hideReticle(companionId, false)
    this.killTween(this.squashTweens, companionId)

    const sprite = this.mechSprites.get(companionId)
    if (sprite) {
      const groundY = sprite.getData('groundY') as number | undefined
      if (groundY !== undefined) sprite.y = groundY
      sprite.setFrame(MECH_IDLE_FRAME)
      sprite.angle = 0
      sprite.scaleY = this.baseScaleY(sprite)
    }
    activeWalk.resolve()
  }

  /**
   * Reactor-breathing idle loop — a barely-visible scaleY oscillation so
   * mechs standing around don't read as frozen sprites. Each mech gets a
   * random start delay so a room full of idle mechs doesn't breathe in
   * lockstep. No-op if a breath tween is already running for this mech, or
   * under reduced motion.
   */
  private startIdleBreath(companionId: string): void {
    // A downed mech doesn't breathe: stop-working runs right after
    // dead-in-field in the same transition pass and would restart it.
    if (this.reducedMotion || this.smokeEmitters.has(companionId)) return
    if (this.idleBreathTweens.has(companionId)) return
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return
    const tween = this.tweens.add({
      targets: sprite,
      scaleY: this.baseScaleY(sprite) * 1.012,
      duration: 1300,
      yoyo: true,
      repeat: -1,
      delay: Math.random() * 2400,
      ease: 'Sine.easeInOut'
    })
    this.idleBreathTweens.set(companionId, tween)
  }

  /**
   * Depth-sort a mech by its feet (its origin), re-derived every time the
   * sprite moves — walk, drag, snap-back. Facilities sort at 50 + y and
   * mechs at 100 + y: the +100 base guarantees a mech at a facility's tile
   * sorts in front of the building, so it always stays clickable while
   * working or dead-in-field.
   */
  private updateMechDepth(sprite: Phaser.GameObjects.Image, feetY?: number): void {
    const y = feetY ?? sprite.y
    sprite.setDepth(100 + y)
  }

  /**
   * Where a mech parks when deployed: one tile south-east of the facility —
   * screen-space directly below it — so it reads as standing at the entrance
   * instead of on the roof, keeps the building art visible, and (with live
   * depth sorting) is always fully clickable. Clamped at the grid edge.
   */
  private facilityStandTile(tile: { x: number; y: number }): { x: number; y: number } {
    return {
      x: Math.min(GRID_W - 1, tile.x + 1),
      y: Math.min(GRID_H - 1, tile.y + 1)
    }
  }

  /**
   * Landing pad under a companion's home tile: an amber-cornered iso
   * diamond with a faint ring, ground-level (depth 1, below every mech/
   * facility). Built once per companion — home tiles don't move.
   */
  private buildHangarPad(companionId: string, homeTile: { x: number; y: number }): void {
    if (this.hangarPads.has(companionId)) return
    const s = isoToScreen(homeTile)
    const w = TILE_W * 0.72
    const h = TILE_H * 0.72
    const g = this.add.graphics().setDepth(1)
    g.fillStyle(0x000000, 0.18)
    g.fillEllipse(s.x, s.y, w, h)
    g.lineStyle(1, AMBER, 0.18)
    g.strokeEllipse(s.x, s.y, w, h)
    const corners = [
      { x: s.x, y: s.y - h / 2 },
      { x: s.x + w / 2, y: s.y },
      { x: s.x, y: s.y + h / 2 },
      { x: s.x - w / 2, y: s.y }
    ]
    g.lineStyle(2, AMBER, 0.4)
    for (const c of corners) {
      g.lineBetween(c.x - 6, c.y, c.x + 6, c.y)
      g.lineBetween(c.x, c.y - 6, c.x, c.y + 6)
    }
    this.hangarPads.set(companionId, g)
  }

  /** Darker iso footprint plate under a facility, with a thin edge-light border. */
  private buildFacilityFoundation(facilityId: string, tile: { x: number; y: number }): void {
    if (this.facilityFoundations.has(facilityId)) return
    const s = isoToScreen(tile)
    const w = FACILITY_DISPLAY_W * 0.62
    const h = FACILITY_DISPLAY_H * 0.5
    const points = [
      { x: s.x, y: s.y - h / 2 },
      { x: s.x + w / 2, y: s.y },
      { x: s.x, y: s.y + h / 2 },
      { x: s.x - w / 2, y: s.y }
    ]
    const g = this.add.graphics().setDepth(1)
    g.fillStyle(0x000000, 0.3)
    g.fillPoints(points, true)
    g.lineStyle(1, CYAN, 0.3)
    g.strokePoints(points, true)
    this.facilityFoundations.set(facilityId, g)
  }

  /**
   * Re-derive the power-conduit layout from the current facility set:
   * dark recessed channels (thin teal core line) from the command-center
   * facility (or the first facility if none) to every other facility, along
   * grid axes via conduitPath (bay-environment.ts). Skipped/rebuilt only
   * when the facility id/tile signature actually changes.
   */
  private rebuildConduits(): void {
    if (!this.state) return
    const facilities = this.state.facilities
    const signature = facilities
      .map((f) => `${f.id}:${f.tile.x},${f.tile.y}`)
      .sort()
      .join('|')
    if (signature === this.conduitSignature) return
    this.conduitSignature = signature

    this.conduitsLayer?.destroy()
    this.conduitsLayer = null
    for (const tween of this.conduitPacketTweens.values()) tween.stop()
    this.conduitPacketTweens.clear()
    for (const packet of this.conduitPackets.values()) packet.destroy()
    this.conduitPackets.clear()
    this.conduitPathPoints.clear()

    if (facilities.length < 2) return
    const hub = facilities.find((f) => f.facilityType === 'command-center') ?? facilities[0]
    const others = facilities.filter((f) => f.id !== hub.id)
    if (others.length === 0) return

    const graphics = this.add.graphics().setDepth(2)
    for (const target of others) {
      const points = conduitPath(hub.tile, target.tile).map(isoToScreen)
      graphics.lineStyle(6, 0x000000, 0.35)
      graphics.strokePoints(points, false)
      graphics.lineStyle(1.5, CYAN, 0.5)
      graphics.strokePoints(points, false)

      const conduitId = `${hub.id}->${target.id}`
      this.conduitPathPoints.set(conduitId, points)
      if (!this.reducedMotion) this.startConduitPacket(conduitId, points)
    }
    this.conduitsLayer = graphics
  }

  /** Interpolate a point at fraction `t` along a poly-line's total length. */
  private pointAlongPath(
    points: Array<{ x: number; y: number }>,
    t: number
  ): { x: number; y: number } {
    if (points.length === 1) return points[0]
    const segmentLengths: number[] = []
    let total = 0
    for (let i = 1; i < points.length; i++) {
      const d = Phaser.Math.Distance.Between(
        points[i - 1].x,
        points[i - 1].y,
        points[i].x,
        points[i].y
      )
      segmentLengths.push(d)
      total += d
    }
    let remaining = Phaser.Math.Clamp(t, 0, 1) * total
    for (let i = 0; i < segmentLengths.length; i++) {
      const len = segmentLengths[i]
      if (remaining <= len || i === segmentLengths.length - 1) {
        const segT = len === 0 ? 0 : Phaser.Math.Clamp(remaining / len, 0, 1)
        return {
          x: Phaser.Math.Linear(points[i].x, points[i + 1].x, segT),
          y: Phaser.Math.Linear(points[i].y, points[i + 1].y, segT)
        }
      }
      remaining -= len
    }
    return points[points.length - 1]
  }

  /** A small glow packet that loops along a conduit's route (motion on only). */
  private startConduitPacket(id: string, points: Array<{ x: number; y: number }>): void {
    if (this.conduitPacketTweens.has(id)) return
    const packet = this.add
      .image(points[0].x, points[0].y, FX.glow)
      .setTint(CYAN)
      .setScale(0.16, 0.1)
      .setAlpha(0.95)
      .setDepth(3)
      .setBlendMode(Phaser.BlendModes.ADD)
    this.conduitPackets.set(id, packet)
    const progress = { t: 0 }
    const tween = this.tweens.add({
      targets: progress,
      t: 1,
      duration: 1800 + Math.random() * 600,
      repeat: -1,
      delay: Math.random() * 1200,
      ease: 'Sine.easeInOut',
      onUpdate: () => {
        const p = this.pointAlongPath(points, progress.t)
        packet.setPosition(p.x, p.y)
      }
    })
    this.conduitPacketTweens.set(id, tween)
  }

  /**
   * Draw a dashed line with a single direction chevron at its midpoint.
   * `offset` shifts the dash pattern along the line — animating it makes
   * the dashes march toward the destination.
   */
  private drawDashedLine(
    g: Phaser.GameObjects.Graphics,
    from: { x: number; y: number },
    to: { x: number; y: number },
    color: number,
    alpha: number,
    offset: number
  ): void {
    const dash = 10
    const gap = 8
    const period = dash + gap
    const dist = Phaser.Math.Distance.Between(from.x, from.y, to.x, to.y)
    const angle = Phaser.Math.Angle.Between(from.x, from.y, to.x, to.y)
    g.lineStyle(2, color, alpha)
    const shift = ((offset % period) + period) % period
    for (let d = shift - period; d < dist; d += period) {
      const segStart = Math.max(0, d)
      const segEnd = Math.min(d + dash, dist)
      if (segEnd <= segStart) continue
      g.lineBetween(
        from.x + Math.cos(angle) * segStart,
        from.y + Math.sin(angle) * segStart,
        from.x + Math.cos(angle) * segEnd,
        from.y + Math.sin(angle) * segEnd
      )
    }
    if (dist < 4) return
    const midD = dist / 2
    const mx = from.x + Math.cos(angle) * midD
    const my = from.y + Math.sin(angle) * midD
    const chevSize = 6
    const perp = angle + Math.PI / 2
    g.lineStyle(2, color, Math.min(1, alpha + 0.2))
    const back1 = {
      x: mx - Math.cos(angle) * chevSize + Math.cos(perp) * chevSize,
      y: my - Math.sin(angle) * chevSize + Math.sin(perp) * chevSize
    }
    const back2 = {
      x: mx - Math.cos(angle) * chevSize - Math.cos(perp) * chevSize,
      y: my - Math.sin(angle) * chevSize - Math.sin(perp) * chevSize
    }
    g.lineBetween(back1.x, back1.y, mx, my)
    g.lineBetween(back2.x, back2.y, mx, my)
  }

  private drawRoute(
    g: Phaser.GameObjects.Graphics,
    from: { x: number; y: number },
    to: { x: number; y: number },
    time: number
  ): void {
    g.clear()
    this.drawDashedLine(g, from, to, AMBER, this.reducedMotion ? 0.35 : 0.6, time * 0.045)
  }

  /** Marching amber route line from a mech's walk start to its destination. */
  private showRouteLine(
    companionId: string,
    from: { x: number; y: number },
    to: { x: number; y: number }
  ): void {
    this.hideRouteLineImmediately(companionId)
    const g = this.add.graphics().setDepth(2)
    this.drawRoute(g, from, to, 0)
    this.routeLines.set(companionId, { g, from, to })
  }

  private hideRouteLineImmediately(companionId: string): void {
    const route = this.routeLines.get(companionId)
    if (!route) return
    this.routeLines.delete(companionId)
    route.g.destroy()
  }

  /** Fade the route line out (walk completed or cancelled) rather than snapping it away. */
  private hideRouteLine(companionId: string): void {
    const route = this.routeLines.get(companionId)
    if (!route) return
    this.routeLines.delete(companionId)
    this.transientEffects.add(route.g)
    this.tweens.add({
      targets: route.g,
      alpha: 0,
      duration: this.reducedMotion ? 200 : 350,
      onComplete: () => {
        this.transientEffects.delete(route.g)
        route.g.destroy()
      }
    })
  }

  /**
   * MechWarrior-style target box over the destination: phosphor corner
   * brackets that lock in from 1.6x, a NAV tag naming the facility, and a
   * slow lock pulse while the mech walks. Static under reduced motion.
   */
  private showReticle(companionId: string, facilityTile: { x: number; y: number }): void {
    this.hideReticleImmediately(companionId)
    const s = isoToScreen(facilityTile)
    const cy = s.y - FACILITY_DISPLAY_H * 0.3
    const ring = this.add
      .graphics()
      .setPosition(s.x, cy)
      .setDepth(60 + s.y)
    const size = FACILITY_DISPLAY_W * 0.4
    this.drawBrackets(ring, size, PHOSPHOR, 0.95, 3.5)
    // Centre pip, like the lock diamond inside a cockpit target box.
    ring.lineStyle(1.5, PHOSPHOR, 0.9)
    ring.strokePoints(
      [
        { x: 0, y: -5 },
        { x: 5, y: 0 },
        { x: 0, y: 5 },
        { x: -5, y: 0 }
      ],
      true
    )
    const name = this.state?.facilities.find(
      (f) => f.tile.x === facilityTile.x && f.tile.y === facilityTile.y
    )?.name
    const label = name
      ? this.add
          .text(s.x, cy + size / 2 + 6, `NAV ▸ ${name.toUpperCase()}`, {
            fontFamily: type.mono,
            fontSize: '12px',
            color: colors.phosphor,
            backgroundColor: 'rgba(7,10,6,0.8)',
            padding: { x: 5, y: 1 },
            resolution: 2
          })
          .setOrigin(0.5, 0)
          .setDepth(OVERLAY_DEPTH - 2)
          .setScale(this.overlayScale())
      : null

    if (this.reducedMotion) {
      this.walkReticles.set(companionId, { ring, tween: null, label })
      return
    }

    ring.setScale(1.6)
    ring.setAlpha(0)
    label?.setAlpha(0)
    sfx.play('target-lock', { volume: 0.7, pan: this.panFor(s.x) })
    const introTween = this.tweens.add({
      targets: [ring, ...(label ? [label] : [])],
      alpha: 1,
      duration: 260,
      ease: 'Quad.Out',
      onUpdate: () => ring.setScale(1 + 0.6 * (1 - ring.alpha)),
      onComplete: () => {
        ring.setScale(1)
        const pulse = this.tweens.add({
          targets: ring,
          alpha: 0.45,
          duration: 700,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        })
        this.walkReticles.set(companionId, { ring, tween: pulse, label })
      }
    })
    this.walkReticles.set(companionId, { ring, tween: introTween, label })
  }

  private hideReticleImmediately(companionId: string): void {
    const entry = this.walkReticles.get(companionId)
    if (!entry) return
    this.walkReticles.delete(companionId)
    entry.tween?.stop()
    entry.ring.destroy()
    entry.label?.destroy()
  }

  /** Flash the reticle once on arrival, then fade it out (rather than snapping away). */
  private hideReticle(companionId: string, flashOnArrival: boolean): void {
    const entry = this.walkReticles.get(companionId)
    if (!entry) return
    this.walkReticles.delete(companionId)
    entry.tween?.stop()
    entry.label?.destroy()
    if (!flashOnArrival) {
      entry.ring.destroy()
      return
    }
    entry.ring.setAlpha(1)
    this.transientEffects.add(entry.ring)
    this.tweens.add({
      targets: entry.ring,
      alpha: 0,
      scale: 0.8,
      duration: this.reducedMotion ? 300 : 420,
      onComplete: () => {
        this.transientEffects.delete(entry.ring)
        entry.ring.destroy()
      }
    })
  }

  /** Chest height of a mech (world y) — where data links and effects attach. */
  private chestY(sprite: Phaser.GameObjects.Image): number {
    return sprite.y - mechHeight(sprite.getData('mechClass') as MechClass) * 0.6
  }

  /**
   * Thin teal data-link line between a working mech and its facility, with
   * packets traveling both directions (motion on) or static (motion off).
   * Rebuildable in place — called again from setReducedMotion's toggle path.
   */
  private startDataLink(companionId: string, facilityId: string): void {
    this.stopDataLink(companionId)
    const sprite = this.mechSprites.get(companionId)
    const facSprite = this.facilitySprites.get(facilityId)
    if (!sprite || !facSprite) return
    const from = { x: sprite.x, y: this.chestY(sprite) }
    const to = { x: facSprite.x, y: facSprite.y }
    const line = this.add.graphics().setDepth(Math.max(1, facSprite.depth + 0.5))
    line.lineStyle(3, CYAN, 0.12)
    line.lineBetween(from.x, from.y, to.x, to.y)
    line.lineStyle(1, CYAN, this.reducedMotion ? 0.3 : 0.55)
    line.lineBetween(from.x, from.y, to.x, to.y)

    const packets: Phaser.GameObjects.Image[] = []
    const tweens: Phaser.Tweens.Tween[] = []
    if (!this.reducedMotion) {
      for (const reverse of [false, true]) {
        const packet = this.add
          .image(from.x, from.y, FX.glow)
          .setTint(CYAN)
          .setScale(0.14)
          .setAlpha(0.95)
          .setDepth(line.depth + 1)
          .setBlendMode(Phaser.BlendModes.ADD)
        const progress = { t: reverse ? 1 : 0 }
        const tween = this.tweens.add({
          targets: progress,
          t: reverse ? 0 : 1,
          duration: 900,
          repeat: -1,
          delay: reverse ? 300 : 0,
          ease: 'Sine.easeInOut',
          onUpdate: () => {
            packet.setPosition(
              Phaser.Math.Linear(from.x, to.x, progress.t),
              Phaser.Math.Linear(from.y, to.y, progress.t)
            )
          }
        })
        packets.push(packet)
        tweens.push(tween)
      }
    }
    this.dataLinks.set(companionId, { facilityId, line, packets, tweens })
  }

  private stopDataLink(companionId: string): void {
    const link = this.dataLinks.get(companionId)
    if (!link) return
    this.dataLinks.delete(companionId)
    for (const tween of link.tweens) tween.stop()
    for (const packet of link.packets) packet.destroy()
    link.line.destroy()
  }

  /** Track a short-lived object and destroy it after `ms`. */
  private expire(obj: Phaser.GameObjects.GameObject, ms: number): void {
    this.transientEffects.add(obj)
    this.time.delayedCall(ms, () => {
      this.transientEffects.delete(obj)
      obj.destroy()
    })
  }

  /** Expanding iso shockwave ring at a ground point. */
  private shockwave(
    x: number,
    y: number,
    depth: number,
    color: number,
    size: number,
    ms: number
  ): void {
    const ring = this.add
      .image(x, y, FX.ring)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(depth)
      .setDisplaySize(size * 0.2, size * 0.1)
      .setAlpha(0.95)
    this.transientEffects.add(ring)
    this.tweens.add({
      targets: ring,
      displayWidth: size,
      displayHeight: size * 0.5,
      alpha: 0,
      duration: ms,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        this.transientEffects.delete(ring)
        ring.destroy()
      }
    })
  }

  /** Burst of hot sparks that arc and fall. */
  private sparkBurst(
    x: number,
    y: number,
    depth: number,
    color: number,
    count: number,
    power = 1
  ): void {
    const sparks = this.add
      .particles(x, y, FX.spark, {
        lifespan: { min: 350, max: 750 },
        speed: { min: 90 * power, max: 240 * power },
        angle: { min: 200, max: 340 },
        gravityY: 520,
        // Orient each streak along its velocity so sparks read as fast motion.
        rotate: { onEmit: sparkHeading, onUpdate: sparkHeading },
        scale: { start: 0.9, end: 0.2 },
        alpha: { start: 1, end: 0 },
        tint: color,
        blendMode: Phaser.BlendModes.ADD,
        emitting: false
      })
      .setDepth(depth)
    sparks.explode(count)
    this.expire(sparks, 800)
  }

  /**
   * Mission complete: an expanding ring at the mech's feet, a light pillar
   * rising from the facility, and a spray of green-gold sparks. Under
   * reduced motion, a single static ring flash instead.
   */
  private playMissionComplete(companionId: string, facilityId: string | undefined): void {
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return
    const green = hex(colors.statusWorking)
    const depth = Math.max(1, sprite.depth - 1)
    if (this.reducedMotion) {
      const ring = this.add.graphics().setPosition(sprite.x, sprite.y).setDepth(depth)
      ring.lineStyle(3, green, 0.85)
      ring.strokeEllipse(0, 0, TILE_W * 0.6, TILE_H * 0.6)
      this.expire(ring, 700)
      return
    }
    this.shockwave(sprite.x, sprite.y, depth, green, TILE_W * 1.8, 700)
    this.sparkBurst(sprite.x, this.chestY(sprite), sprite.depth + 1, AMBER, 14, 0.7)

    const facSprite = facilityId ? this.facilitySprites.get(facilityId) : undefined
    if (facSprite) {
      const baseY = facSprite.y + FACILITY_DISPLAY_H * 0.28
      const pillar = this.add
        .image(facSprite.x, baseY, FX.beam)
        .setOrigin(0.5, 1)
        .setTint(green)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(facSprite.depth + 2)
        .setDisplaySize(70, 20)
        .setAlpha(0.9)
      this.transientEffects.add(pillar)
      this.tweens.add({
        targets: pillar,
        displayHeight: 420,
        displayWidth: 44,
        duration: 380,
        ease: 'Cubic.easeOut',
        onComplete: () => {
          this.tweens.add({
            targets: pillar,
            alpha: 0,
            displayWidth: 8,
            duration: 700,
            ease: 'Quad.easeIn',
            onComplete: () => {
              this.transientEffects.delete(pillar)
              pillar.destroy()
            }
          })
        }
      })
      this.shockwave(facSprite.x, baseY, facSprite.depth + 1, green, FACILITY_DISPLAY_W * 1.3, 900)
    }
    this.cameras.main.shake(160, 0.0014)
  }

  /**
   * Mission failure: the mech takes a hit — a white-hot flash, a spray of
   * sparks and debris, a rolling smoke plume, a red warning ring, and a
   * camera jolt. Under reduced motion, only the red ring flash.
   */
  private playFailureExplosion(companionId: string): void {
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return
    const depth = Math.max(1, sprite.depth - 1)

    const ring = this.add.graphics().setPosition(sprite.x, sprite.y).setDepth(depth)
    ring.lineStyle(3, RED, 0.9)
    ring.strokeEllipse(0, 0, TILE_W * 0.6, TILE_H * 0.6)
    this.transientEffects.add(ring)
    this.tweens.add({
      targets: ring,
      alpha: 0,
      duration: this.reducedMotion ? 500 : 600,
      delay: this.reducedMotion ? 0 : 250,
      onComplete: () => {
        this.transientEffects.delete(ring)
        ring.destroy()
      }
    })
    if (this.reducedMotion) return

    sfx.play('explosion', { pan: this.panFor(sprite.x) })
    const chest = this.chestY(sprite)
    const flash = this.add
      .image(sprite.x, chest, FX.glow)
      .setTint(0xffd9a0)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(sprite.depth + 2)
      .setScale(1.1)
    this.transientEffects.add(flash)
    this.tweens.add({
      targets: flash,
      scale: 4.6,
      alpha: 0,
      duration: 480,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        this.transientEffects.delete(flash)
        flash.destroy()
      }
    })
    this.sparkBurst(sprite.x, chest, sprite.depth + 2, 0xffa24a, 36, 1.3)

    const debris = this.add
      .particles(sprite.x, chest, FX.debris, {
        lifespan: { min: 500, max: 900 },
        speed: { min: 80, max: 200 },
        angle: { min: 200, max: 340 },
        gravityY: 600,
        rotate: { min: 0, max: 360 },
        scale: { min: 0.6, max: 1.4 },
        tint: [0x3a3a34, 0x55524a, 0x2a2622],
        emitting: false
      })
      .setDepth(sprite.depth + 1)
    debris.explode(20)
    this.expire(debris, 950)

    const plume = this.add
      .particles(sprite.x, chest, FX.puff, {
        lifespan: 1600,
        speed: { min: 12, max: 40 },
        angle: { min: 240, max: 300 },
        scale: { start: 0.5, end: 1.6 },
        alpha: { start: 0.7, end: 0 },
        rotate: { min: 0, max: 360 },
        tint: [0x3b3834, 0x2b2825],
        emitting: false
      })
      .setDepth(sprite.depth + 1)
    plume.explode(10)
    this.expire(plume, 1700)

    this.shockwave(sprite.x, sprite.y, depth, 0xffa24a, TILE_W * 1.4, 500)
    this.cameras.main.shake(260, 0.004)
  }

  /**
   * The sprite's resting scaleY, captured right after setDisplaySize()
   * at creation. All scale animations must be multiples of this.
   */
  private baseScaleY(sprite: Phaser.GameObjects.Image): number {
    return (sprite.getData('baseScaleY') as number | undefined) ?? sprite.scaleY
  }

  /** Stop and forget a tracked tween, if one exists for this id. */
  private killTween(map: Map<string, Phaser.Tweens.Tween>, id: string): void {
    const tween = map.get(id)
    if (!tween) return
    tween.stop()
    map.delete(id)
  }

  /**
   * Footfall dust emitter for a walking mech. It never emits on its own —
   * onFootfall() explodes a puff at the landing foot — so dust lands in
   * rhythm with the gait instead of trailing continuously.
   */
  private startFootDust(companionId: string, sprite: Phaser.GameObjects.Image): void {
    if (this.reducedMotion) return
    this.stopFootDust(companionId)
    const gait = GAITS[(sprite.getData('mechClass') as MechClass | undefined) ?? 'atlas']
    const dust = this.add.particles(0, 0, FX.puff, {
      lifespan: { min: 450, max: 800 },
      speed: { min: 10, max: 34 * gait.dust },
      angle: { min: 190, max: 350 },
      alpha: { start: 0.55, end: 0 },
      scale: { start: 0.14 * gait.dust, end: 0.42 * gait.dust },
      rotate: { min: 0, max: 360 },
      tint: 0x8a8578,
      emitting: false
    })
    dust.setDepth(Math.max(1, sprite.depth - 1))
    this.footDustEmitters.set(companionId, dust)
  }

  /** Stop tracking the dust emitter; already-alive particles finish fading on their own. */
  private stopFootDust(companionId: string): void {
    const dust = this.footDustEmitters.get(companionId)
    if (!dust) return
    this.footDustEmitters.delete(companionId)
    this.time.delayedCall(850, () => dust.destroy())
  }

  /**
   * Arrival: a landing squash that overshoots back to rest, a dust ring,
   * and a heavy thud, then hand back off to idle breathing.
   */
  private playArrival(
    companionId: string,
    sprite: Phaser.GameObjects.Image,
    gait: GaitProfile
  ): void {
    const base = this.baseScaleY(sprite)
    this.killTween(this.squashTweens, companionId)
    if (!this.reducedMotion) {
      const burst = this.add.particles(sprite.x, sprite.y, FX.puff, {
        lifespan: 700,
        speed: { min: 20, max: 55 * gait.dust },
        angle: { min: 180, max: 360 },
        alpha: { start: 0.55, end: 0 },
        scale: { start: 0.18 * gait.dust, end: 0.5 * gait.dust },
        rotate: { min: 0, max: 360 },
        tint: 0x8a8578,
        emitting: false
      })
      burst.setDepth(Math.max(1, sprite.depth - 1))
      burst.explode(8)
      this.expire(burst, 720)
      sfx.play('land', { volume: 0.5 + gait.squash * 8, pan: this.panFor(sprite.x) })
      sprite.scaleY = base * (1 - gait.squash * 1.6)
    }
    const settle = this.tweens.add({
      targets: sprite,
      scaleY: base,
      duration: this.reducedMotion ? 1 : 320,
      ease: 'Back.easeOut',
      onComplete: () => {
        sprite.scaleY = base
        this.squashTweens.delete(companionId)
        this.startIdleBreath(companionId)
      }
    })
    this.squashTweens.set(companionId, settle)
  }

  /**
   * Dead-in-field: tint the mech gray, fade to 60% alpha, attach a smoke
   * plume and intermittent electrical crackle, and wire a single-shot click
   * handler to recover — restore full color + alpha and walk home. Called
   * on the leading edge of a `failed` transition so it fires exactly once
   * per failed deployment.
   */
  applyDeadInField(companionId: string): void {
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return

    sprite.setTint(0x666666)
    sprite.setAlpha(0.7)
    this.killTween(this.idleBreathTweens, companionId)
    sprite.scaleY = this.baseScaleY(sprite)
    sprite.angle = sprite.flipX ? 3 : -3

    const smoke = this.add.particles(sprite.x, this.chestY(sprite), FX.puff, {
      speed: { min: 10, max: 30 },
      angle: { min: 250, max: 290 },
      lifespan: 2200,
      alpha: { start: 0.55, end: 0 },
      scale: { start: 0.3, end: 1.1 },
      rotate: { min: 0, max: 360 },
      frequency: 170,
      tint: [0x8a867e, 0x6b6760]
    })
    smoke.setDepth(sprite.depth + 1)
    this.smokeEmitters.set(companionId, smoke)

    // Blinking red damage light on the chassis — the "unit down" tell that
    // survives even when the smoke is lost against the dark deck.
    const warning = this.add
      .image(sprite.x, this.chestY(sprite), FX.glow)
      .setTint(RED)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(sprite.depth + 1)
      .setScale(0.55)
      .setAlpha(0.85)
    this.damageLights.set(companionId, warning)
    if (!this.reducedMotion) {
      this.tweens.add({
        targets: warning,
        alpha: 0.1,
        duration: 480,
        yoyo: true,
        repeat: -1,
        ease: 'Stepped',
        easeParams: [3]
      })
    }

    if (!this.reducedMotion) {
      const crackle = this.time.addEvent({
        delay: 900,
        loop: true,
        callback: () => {
          if (Math.random() < 0.55) {
            const x = sprite.x + Phaser.Math.Between(-14, 14)
            this.sparkBurst(x, this.chestY(sprite), sprite.depth + 1, 0x9fd7ff, 5, 0.4)
          }
        }
      })
      this.crackleTimers.set(companionId, crackle)
    }

    // Disable dragging while dead — otherwise the base handlers fire
    // pointerup AFTER dragend and double-trigger recovery. Using
    // pointerdown for recovery also means a stray drag attempt on a dead
    // mech can't accidentally both snap-home AND walk-home.
    this.input.setDraggable(sprite, false)
    sprite.once('pointerdown', () => {
      this.clearDeadInField(companionId)
      sfx.play('power-up', { pan: this.panFor(sprite.x) })
      const companion = this.state?.companions.find((c) => c.id === companionId)
      if (companion) void this.walkTo(companionId, companion.homeTile)
    })
  }

  private clearDeadInField(companionId: string): void {
    const sprite = this.mechSprites.get(companionId)
    if (sprite && this.smokeEmitters.has(companionId)) {
      sprite.clearTint()
      sprite.setAlpha(1)
      sprite.angle = 0
      this.input.setDraggable(sprite, true)
    }
    const smoke = this.smokeEmitters.get(companionId)
    if (smoke) {
      smoke.destroy()
      this.smokeEmitters.delete(companionId)
    }
    this.crackleTimers.get(companionId)?.remove()
    this.crackleTimers.delete(companionId)
    const warning = this.damageLights.get(companionId)
    if (warning) {
      this.tweens.killTweensOf(warning)
      warning.destroy()
      this.damageLights.delete(companionId)
    }
  }

  private showCompletionBubble(companionId: string, deployment: Deployment): void {
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return

    const stats = deployment.diffStats
    const message = !stats
      ? '✓ done'
      : stats.filesChanged === 0
        ? '✓ no changes'
        : `✓ ${stats.filesChanged} file${stats.filesChanged === 1 ? '' : 's'} +${stats.insertions} −${stats.deletions}`
    const label = this.add
      .text(0, 0, message, {
        fontFamily: type.mono,
        fontSize: '13px',
        fontStyle: 'bold',
        color: colors.cyan,
        resolution: 2
      })
      .setOrigin(0.5)
    const width = label.width + 12
    const height = label.height + 6
    const background = this.add.graphics()
    background.fillStyle(hex(colors.bgPanelDark), 0.9)
    background.fillRect(-width / 2, -height / 2, width, height)
    background.lineStyle(1, CYAN, 0.55)
    background.strokeRect(-width / 2, -height / 2, width, height)

    const mechClass = sprite.getData('mechClass') as MechClass
    const bubble = this.add
      .container(sprite.x, sprite.y - mechHeight(mechClass) - 18, [background, label])
      .setDepth(OVERLAY_DEPTH)
      .setScale(this.overlayScale())
    this.completionBubbles.add(bubble)
    this.tweens.add({
      targets: bubble,
      y: bubble.y - 30,
      alpha: 0,
      duration: 4000,
      ease: 'Sine.easeOut',
      onComplete: () => {
        this.completionBubbles.delete(bubble)
        bubble.destroy()
      }
    })
  }

  /**
   * Track the selected mech: ring, glow, unit plate. Called from the mech's
   * own pointerup and from React (roster / dispatch select) — the bus event
   * drives the React panel, this drives the Phaser side.
   */
  setSelectedCompanion(companionId: string): void {
    if (this.selectedCompanionId === companionId) return
    const prev = this.selectedCompanionId
    this.selectedCompanionId = companionId
    if (prev) {
      this.refreshMechGlow(prev)
      if (prev !== this.hoveredCompanionId) this.hideUnitPlate(prev)
    }
    this.refreshMechGlow(companionId)
    this.showUnitPlate(companionId)
    this.destroySelectionRing()
    this.createSelectionRing(companionId)
    bus.emit('mechHeading', { companionId, heading: this.mechHeading(companionId) })
    const mechClass = this.mechSprites.get(companionId)?.getData('mechClass') as
      MechClass | undefined
    const sprite = this.mechSprites.get(companionId)
    sfx.play('select', {
      rate: mechClass ? MECH_VOICE_RATE[mechClass] : 1,
      pan: sprite ? this.panFor(sprite.x) : 0
    })
  }

  /**
   * RTS-style selection ring: a pulsing iso-perspective ellipse under the
   * mech's feet with four tick marks. Plays a quick expand-in on first
   * selection, then settles into an alpha pulse. Under reduced motion, the
   * ring is drawn once at a fixed alpha with no pulse and no expand-in.
   */
  private createSelectionRing(companionId: string): void {
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return

    const mechClass = sprite.getData('mechClass') as MechClass
    const ring = this.add.graphics()
    const ringW = Math.max(TILE_W * 0.5, MECH_SHADOW_W[mechClass] * 1.25)
    const ringH = ringW / 2
    ring.lineStyle(2, CYAN, 1)
    ring.strokeEllipse(0, 0, ringW, ringH)
    ring.lineStyle(2, CYAN, 1)
    for (const [x, y, dx, dy] of [
      [ringW / 2, 0, 6, 0],
      [-ringW / 2, 0, -6, 0],
      [0, ringH / 2, 0, 4],
      [0, -ringH / 2, 0, -4]
    ]) {
      ring.lineBetween(x, y, x + dx, y + dy)
    }
    ring.setPosition(sprite.x, this.groundY(companionId, sprite))
    ring.setDepth(Math.max(1, sprite.depth - 1))
    this.selectionRing = ring

    if (this.reducedMotion) {
      ring.setAlpha(0.6)
      return
    }

    ring.setScale(1.4)
    ring.setAlpha(0)
    this.tweens.add({
      targets: ring,
      scale: 1,
      alpha: 0.85,
      duration: 200,
      ease: 'Quad.Out',
      onComplete: () => {
        this.selectionRingTween = this.tweens.add({
          targets: ring,
          alpha: 0.35,
          duration: 1200,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        })
      }
    })
  }

  private destroySelectionRing(): void {
    if (this.selectionRingTween) {
      this.selectionRingTween.stop()
      this.selectionRingTween = null
    }
    if (this.selectionRing) {
      this.tweens.killTweensOf(this.selectionRing)
      this.selectionRing.destroy()
      this.selectionRing = null
    }
  }

  /**
   * "Servos active": a slow rotation sway on the mech, the data link, a
   * pulsing work light, weld sparks at the facility, a spinning hologram
   * ring over the roof, and the work hum. All torn down together by
   * stopWorkingState() the moment the deployment leaves 'working'.
   */
  private startWorkingState(companionId: string, facilityId: string): void {
    this.killTween(this.idleBreathTweens, companionId)
    const sprite = this.mechSprites.get(companionId)
    if (sprite) sprite.scaleY = this.baseScaleY(sprite)

    if (sprite && !this.reducedMotion) {
      const swayTween = this.tweens.add({
        targets: sprite,
        angle: sprite.flipX ? -1.2 : 1.2,
        duration: 1400,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      })
      this.workingSwayTweens.set(companionId, swayTween)
    }

    this.startDataLink(companionId, facilityId)
    this.startHoloRing(facilityId)
    sfx.startLoop(`work-${companionId}`, 'work', { volume: 0.5 })

    if (this.workLights.has(facilityId)) return
    const facSprite = this.facilitySprites.get(facilityId)
    if (!facSprite) return
    const light = this.add
      .image(facSprite.x, facSprite.y - FACILITY_DISPLAY_H * 0.05, FX.glow)
      .setTint(AMBER)
      .setScale(2.2, 1.3)
      .setAlpha(this.reducedMotion ? 0.35 : 0.15)
      .setDepth(facSprite.depth + 1)
      .setBlendMode(Phaser.BlendModes.ADD)
    this.workLights.set(facilityId, light)
    if (!this.reducedMotion) {
      const lightTween = this.tweens.add({
        targets: light,
        alpha: 0.5,
        duration: 900,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      })
      this.workLightTweens.set(facilityId, lightTween)
    }
    this.startWelding(facilityId)
  }

  private stopWorkingState(companionId: string, facilityId: string): void {
    this.killTween(this.workingSwayTweens, companionId)
    const sprite = this.mechSprites.get(companionId)
    if (sprite && !this.smokeEmitters.has(companionId)) sprite.angle = 0
    this.startIdleBreath(companionId)
    this.stopDataLink(companionId)
    sfx.stopLoop(`work-${companionId}`)

    // Another mech may still be working the same facility.
    const stillWorked = this.state?.deployments.some(
      (d) => d.facilityId === facilityId && d.status === 'working' && d.companionId !== companionId
    )
    if (stillWorked) return
    this.killTween(this.workLightTweens, facilityId)
    const light = this.workLights.get(facilityId)
    if (light) {
      light.destroy()
      this.workLights.delete(facilityId)
    }
    this.stopWelding(facilityId)
    this.stopHoloRing(facilityId)
  }

  /**
   * Weld sparks at irregular intervals from random points on the lower
   * half of a working facility — the building is visibly being worked on.
   */
  private startWelding(facilityId: string): void {
    if (this.reducedMotion || this.weldTimers.has(facilityId)) return
    const facSprite = this.facilitySprites.get(facilityId)
    if (!facSprite) return
    const schedule = (): Phaser.Time.TimerEvent =>
      this.time.delayedCall(Phaser.Math.Between(380, 1100), () => {
        const x = facSprite.x + Phaser.Math.FloatBetween(-0.28, 0.28) * FACILITY_DISPLAY_W
        const y = facSprite.y + Phaser.Math.FloatBetween(-0.05, 0.25) * FACILITY_DISPLAY_H
        const flare = this.add
          .image(x, y, FX.flare)
          .setTint(0xcdefff)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(facSprite.depth + 1)
          .setScale(0.5)
          .setAngle(Phaser.Math.Between(0, 45))
        this.transientEffects.add(flare)
        this.tweens.add({
          targets: flare,
          scale: 0.1,
          alpha: 0,
          duration: 260,
          onComplete: () => {
            this.transientEffects.delete(flare)
            flare.destroy()
          }
        })
        this.sparkBurst(x, y, facSprite.depth + 1, 0xffc46b, Phaser.Math.Between(4, 8), 0.55)
        this.weldTimers.set(facilityId, schedule())
      })
    this.weldTimers.set(facilityId, schedule())
  }

  private stopWelding(facilityId: string): void {
    this.weldTimers.get(facilityId)?.remove()
    this.weldTimers.delete(facilityId)
  }

  /**
   * Hologram over a working facility: two segmented rings counter-rotating
   * in the iso plane (a container squashed to iso proportions holds them,
   * so the rotation happens on the flat disc). Static under reduced motion.
   */
  private startHoloRing(facilityId: string): void {
    if (this.holoRings.has(facilityId)) return
    const facSprite = this.facilitySprites.get(facilityId)
    if (!facSprite) return
    const disc = this.add
      .image(0, 0, FX.glow)
      .setTint(CYAN)
      .setScale(2.2)
      .setAlpha(0.22)
      .setBlendMode(Phaser.BlendModes.ADD)
    const outer = this.add.graphics()
    outer.lineStyle(4, CYAN, 0.9)
    const segments = 6
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2
      outer.beginPath()
      outer.arc(0, 0, 58, a0, a0 + (Math.PI * 2) / segments - 0.28)
      outer.strokePath()
    }
    const inner = this.add.graphics()
    inner.lineStyle(2, CYAN, 0.75)
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      const r0 = i % 6 === 0 ? 34 : 38
      inner.lineBetween(Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * 42, Math.sin(a) * 42)
    }
    for (const g of [outer, inner]) g.setBlendMode(Phaser.BlendModes.ADD)
    const container = this.add
      .container(facSprite.x, facSprite.y - FACILITY_DISPLAY_H * 0.62, [disc, outer, inner])
      .setScale(1, 0.42)
      .setDepth(facSprite.depth + 2)
    const tweens: Phaser.Tweens.Tween[] = []
    if (!this.reducedMotion) {
      container.setAlpha(0)
      tweens.push(
        this.tweens.add({ targets: container, alpha: 0.9, duration: 400 }),
        this.tweens.add({ targets: outer, angle: 360, duration: 5200, repeat: -1 }),
        this.tweens.add({ targets: inner, angle: -360, duration: 8000, repeat: -1 }),
        this.tweens.add({
          targets: container,
          y: container.y - 5,
          duration: 1600,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        })
      )
    } else {
      container.setAlpha(0.6)
    }
    this.holoRings.set(facilityId, { container, tweens })
  }

  private stopHoloRing(facilityId: string): void {
    const holo = this.holoRings.get(facilityId)
    if (!holo) return
    for (const tween of holo.tweens) tween.stop()
    holo.container.destroy(true)
    this.holoRings.delete(facilityId)
  }

  /**
   * Per-building life: live smoke from the Foundry's chimneys, a pulsing
   * light on the Command Center's tower. Pure ambience — skipped under
   * reduced motion like the facility beacons.
   */
  private startFacilityAmbience(facilityId: string): void {
    if (this.reducedMotion || this.facilityAmbience.has(facilityId)) return
    const sprite = this.facilitySprites.get(facilityId)
    const spec = FACILITY_AMBIENCE[sprite?.getData('facilityType') as FacilityType]
    if (!sprite || !spec) return
    const toWorld = ([sx, sy]: [number, number]): { x: number; y: number } => ({
      x: sprite.x + (sx / FACILITY_SOURCE_W - 0.5) * FACILITY_DISPLAY_W,
      y: sprite.y + (sy / FACILITY_SOURCE_H - 0.5) * FACILITY_DISPLAY_H
    })
    const parts: Phaser.GameObjects.GameObject[] = []
    for (const point of spec.smoke ?? []) {
      const p = toWorld(point)
      const smoke = this.add
        .particles(p.x, p.y, FX.puff, {
          lifespan: { min: 2200, max: 3200 },
          speed: { min: 8, max: 16 },
          angle: { min: 262, max: 290 },
          accelerationX: 5,
          scale: { start: 0.22, end: 0.85 },
          alpha: { start: 0.42, end: 0 },
          rotate: { min: 0, max: 360 },
          frequency: 320,
          tint: [0x77736b, 0x5f5b55]
        })
        .setDepth(sprite.depth + 0.5)
      parts.push(smoke)
    }
    if (spec.beacon) {
      const p = toWorld(spec.beacon)
      const glow = this.add
        .image(p.x, p.y, FX.glow)
        .setTint(0xff4a3a)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(sprite.depth + 0.5)
        .setScale(0.4)
        .setAlpha(0.2)
      this.tweens.add({
        targets: glow,
        alpha: 0.85,
        scale: 0.55,
        duration: 700,
        yoyo: true,
        repeat: -1,
        hold: 200,
        ease: 'Sine.easeInOut'
      })
      parts.push(glow)
    }
    this.facilityAmbience.set(facilityId, parts)
  }

  private stopFacilityAmbience(facilityId: string): void {
    const parts = this.facilityAmbience.get(facilityId)
    if (!parts) return
    for (const part of parts) {
      this.tweens.killTweensOf(part)
      part.destroy()
    }
    this.facilityAmbience.delete(facilityId)
  }

  /**
   * Tiny blinking amber beacon on every facility (working or not) so the
   * bay reads as alive even when nothing is deployed. Staggered per-facility
   * period keeps them from blinking in unison. Skipped entirely under
   * reduced motion rather than drawn static — pure ambience.
   */
  private createFacilityBeacon(
    facilityId: string,
    screenPos: { x: number; y: number },
    index: number
  ): void {
    if (this.reducedMotion) return
    const beacon = this.add
      .image(screenPos.x, screenPos.y - FACILITY_DISPLAY_H * 0.55, FX.glow)
      .setTint(AMBER)
      .setScale(0.14)
      .setAlpha(0.1)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(50 + screenPos.y + 1)
    this.facilityBeacons.set(facilityId, beacon)
    const tween = this.tweens.add({
      targets: beacon,
      alpha: 0.9,
      duration: 1800 + index * 230,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    })
    this.facilityBeaconTweens.set(facilityId, tween)
  }

  /**
   * Phaser calls this on scene stop/restart. Particle emitters created
   * via `this.add.particles()` are NOT auto-destroyed with the scene, so
   * they leak GPU resources on repeat shutdowns (rare in the current
   * Electron-single-scene app, but trivial to get right).
   */
  shutdown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.applyResolution, this)
    for (const companionId of [...this.activeWalks.keys()]) {
      this.cancelActiveWalk(companionId)
    }
    this.activeWalks.clear()
    for (const companionId of [...this.smokeEmitters.keys()]) this.clearDeadInField(companionId)
    for (const label of this.unavailableLabels.values()) {
      label.destroy()
    }
    this.unavailableLabels.clear()
    for (const bubble of this.completionBubbles) {
      this.tweens.killTweensOf(bubble)
      bubble.destroy()
    }
    this.completionBubbles.clear()

    for (const tween of this.idleBreathTweens.values()) tween.stop()
    this.idleBreathTweens.clear()
    for (const tween of this.workingSwayTweens.values()) tween.stop()
    this.workingSwayTweens.clear()
    for (const tween of this.squashTweens.values()) tween.stop()
    this.squashTweens.clear()
    for (const dust of this.footDustEmitters.values()) dust.destroy()
    this.footDustEmitters.clear()
    for (const tween of this.workLightTweens.values()) tween.stop()
    this.workLightTweens.clear()
    for (const light of this.workLights.values()) light.destroy()
    this.workLights.clear()
    for (const id of [...this.weldTimers.keys()]) this.stopWelding(id)
    for (const id of [...this.holoRings.keys()]) this.stopHoloRing(id)
    for (const id of [...this.facilityAmbience.keys()]) this.stopFacilityAmbience(id)
    for (const tween of this.facilityBeaconTweens.values()) tween.stop()
    this.facilityBeaconTweens.clear()
    for (const beacon of this.facilityBeacons.values()) beacon.destroy()
    this.facilityBeacons.clear()
    for (const label of this.facilityLabels.values()) label.destroy()
    this.facilityLabels.clear()
    for (const shadow of this.mechShadows.values()) shadow.destroy()
    this.mechShadows.clear()
    this.destroySelectionRing()
    this.selectedCompanionId = null
    this.hoveredCompanionId = null
    for (const id of [...this.unitPlates.keys()]) this.hideUnitPlate(id)
    for (const id of [...this.statusMarkers.keys()]) this.removeStatusMarker(id)
    this.endDragTargeting()
    this.glows.clear()
    for (const id of this.mechSprites.keys()) sfx.stopLoop(`work-${id}`)

    // Living-bay environment layer.
    for (const pad of this.hangarPads.values()) pad.destroy()
    this.hangarPads.clear()
    for (const foundation of this.facilityFoundations.values()) foundation.destroy()
    this.facilityFoundations.clear()
    this.conduitsLayer?.destroy()
    this.conduitsLayer = null
    this.conduitSignature = ''
    this.conduitPathPoints.clear()
    for (const tween of this.conduitPacketTweens.values()) tween.stop()
    this.conduitPacketTweens.clear()
    for (const packet of this.conduitPackets.values()) packet.destroy()
    this.conduitPackets.clear()
    this.apronLayer?.destroy()
    this.apronLayer = null
    this.teardownRimChase()
    this.teardownAtmosphere()
    this.teardownRadar()
    this.minimap?.destroy()
    this.minimap = null

    // Deploy cinematics.
    for (const [companionId] of [...this.walkReticles]) this.hideReticleImmediately(companionId)
    for (const [companionId] of [...this.routeLines]) this.hideRouteLineImmediately(companionId)
    for (const companionId of [...this.dataLinks.keys()]) this.stopDataLink(companionId)
    for (const effect of this.transientEffects) {
      this.tweens.killTweensOf(effect)
      effect.destroy()
    }
    this.transientEffects.clear()

    bus.off('bayResetView', this.handleResetView)
    this.isPanningCamera = false
    this.isMinimapDrag = false
    this.userZoom = 1
    this.userPan = { x: 0, y: 0 }

    if (this.demoLayoutEnabled) {
      delete window.__mechbayBayLayout
      delete window.__mechbayState
    }
    this.demoLayoutEnabled = false
    this.demoLayoutSignature = ''
  }

  /**
   * Diff two state snapshots and trigger animations for deployment status
   * transitions. The diff itself is pure (`computeDeploymentActions`) so it
   * can be unit-tested without Phaser; this method just maps actions onto
   * scene effects. Brand-new deployments count as transitions — they are
   * BORN in 'walking-to', so skipping them means mechs never walk (the
   * v1.2.1-and-earlier bug).
   */
  private reactToDeploymentTransitions(prev: AppState, next: AppState): void {
    const actions = computeDeploymentActions(prev.deployments, next.deployments)
    for (const action of actions) {
      switch (action.kind) {
        case 'walk-to-facility': {
          const facility = next.facilities.find((candidate) => candidate.id === action.facilityId)
          if (facility) {
            void this.walkTo(action.companionId, this.facilityStandTile(facility.tile), {
              facilityTile: facility.tile
            })
          }
          break
        }
        case 'start-working': {
          const activeWalk = this.activeWalks.get(action.companionId)
          if (activeWalk) {
            void activeWalk.promise.then(() => {
              if (!activeWalk.cancelled) {
                this.startWorkingState(action.companionId, action.facilityId)
              }
            })
          } else {
            this.startWorkingState(action.companionId, action.facilityId)
          }
          break
        }
        case 'stop-working':
          this.stopWorkingState(action.companionId, action.facilityId)
          break
        case 'dead-in-field':
          this.cancelActiveWalk(action.companionId)
          this.applyDeadInField(action.companionId)
          this.playFailureExplosion(action.companionId)
          break
        case 'completion-bubble': {
          const deployment = next.deployments.find(
            (candidate) => candidate.id === action.deploymentId
          )
          this.playMissionComplete(action.companionId, deployment?.facilityId)
          if (deployment) this.showCompletionBubble(action.companionId, deployment)
          break
        }
        case 'walk-home': {
          const companion = next.companions.find((candidate) => candidate.id === action.companionId)
          if (companion) void this.walkTo(action.companionId, companion.homeTile)
          break
        }
      }
    }
    // Status-derived read-outs (markers, plates) track the new snapshot.
    this.syncStatusMarkers(false)
    this.refreshUnitPlates()
  }
}
