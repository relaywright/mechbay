import Phaser from 'phaser'
import type { AppState, Deployment, FacilityType, MechClass } from '../../../shared/types'
import { bus } from '../bus'
import { colors, type } from '../theme'
import { computeFacingFlipX, computeWalkBob, computeWalkFrame } from './bay-animation'
import { canvasPointToPage } from './bay-layout'
import { computeDeploymentActions } from './deployment-transitions'
import { deckTile, conduitPath, clampZoom, clampPan, panBounds } from './bay-environment'
import { textResolutionForZoom } from './text-resolution'

import atlasUrl from '../../../../assets/mechs/atlas-poc.png?url'
import marauderUrl from '../../../../assets/mechs/marauder-poc.png?url'
import ravenUrl from '../../../../assets/mechs/raven-poc.png?url'
import catapultUrl from '../../../../assets/mechs/catapult-poc.png?url'
import locustUrl from '../../../../assets/mechs/locust-poc.png?url'

import atlasWalkUrl from '../../../../assets/mechs/walk/atlas-walk.png?url'
import marauderWalkUrl from '../../../../assets/mechs/walk/marauder-walk.png?url'
import ravenWalkUrl from '../../../../assets/mechs/walk/raven-walk.png?url'
import catapultWalkUrl from '../../../../assets/mechs/walk/catapult-walk.png?url'
import locustWalkUrl from '../../../../assets/mechs/walk/locust-walk.png?url'

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
 * Heavy-mech walk feel. Mechs move at a constant ground speed (world px per
 * second) rather than a fixed per-walk duration, so a long trek across the
 * bay reads as the same deliberate, weighty pace as a short hop — never a
 * sprint. Clamped so pathological short/long distances still feel right.
 */
const WALK_SPEED_PX_PER_SEC = 130
const WALK_MIN_MS = 1400
const WALK_MAX_MS = 5200

const MECH_KEY: Record<MechClass, string> = {
  atlas: 'mech-atlas',
  marauder: 'mech-marauder',
  raven: 'mech-raven',
  catapult: 'mech-catapult',
  locust: 'mech-locust'
}

const MECH_WALK_KEY: Record<MechClass, string> = {
  atlas: 'mech-atlas-walk',
  marauder: 'mech-marauder-walk',
  raven: 'mech-raven-walk',
  catapult: 'mech-catapult-walk',
  locust: 'mech-locust-walk'
}

const MECH_WALK_URL: Record<MechClass, string> = {
  atlas: atlasWalkUrl,
  marauder: marauderWalkUrl,
  raven: ravenWalkUrl,
  catapult: catapultWalkUrl,
  locust: locustWalkUrl
}

/** Cell size of the generated walk sheets (4 frames packed horizontally). */
const WALK_SHEET_FRAME = 256

const FACILITY_KEY: Record<FacilityType, string> = {
  'security-bay': 'facility-security-bay',
  'research-lab': 'facility-research-lab',
  foundry: 'facility-foundry',
  'command-center': 'facility-command-center',
  'salvage-dock': 'facility-salvage-dock',
  'data-archive': 'facility-data-archive'
}

// Display height for mech sprites after downscaling from Gemini's ~1024 output.
// Mechs hover at roughly 1 tile × 1.5 tile iso footprint.
const MECH_DISPLAY_SIZE = 120

// Facilities span ~2 tiles wide × ~1.5 tiles tall on the grid.
const FACILITY_DISPLAY_W = 224
const FACILITY_DISPLAY_H = 168

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

/** Distance (px) a pointer must move between down + up to count as a drag. */
const CLICK_DRAG_THRESHOLD = 8

/**
 * Phaser scene for the isometric mech bay. Wave 3 loaded real sprites via
 * Vite `?url` imports; the bay is a 16×16 iso grid rendered in 3/4 projection
 * with 128×64 diamond tiles.
 */
export class BayScene extends Phaser.Scene {
  private state: AppState | null = null
  private demoLayoutEnabled = false
  private demoLayoutSignature = ''
  private mechSprites = new Map<string, Phaser.GameObjects.Image>()
  private facilitySprites = new Map<string, Phaser.GameObjects.Image>()
  private facilityLabels = new Map<string, Phaser.GameObjects.Text>()
  private smokeEmitters = new Map<string, Phaser.GameObjects.Particles.ParticleEmitter>()
  private unavailableLabels = new Map<string, Phaser.GameObjects.Text>()
  private completionBubbles = new Set<Phaser.GameObjects.Container>()

  // --- Animation-pass state (Wave 7). Every Map/ref here is torn down in
  // shutdown() AND in render()'s entity-removal sweep, mirroring the
  // cleanup pattern already used for smokeEmitters/unavailableLabels above.
  private reducedMotion = false
  private selectedCompanionId: string | null = null
  private selectionRing: Phaser.GameObjects.Graphics | null = null
  private selectionRingTween: Phaser.Tweens.Tween | null = null
  private idleBreathTweens = new Map<string, Phaser.Tweens.Tween>()
  private workingSwayTweens = new Map<string, Phaser.Tweens.Tween>()
  private footDustEmitters = new Map<string, Phaser.GameObjects.Particles.ParticleEmitter>()
  private workLights = new Map<string, Phaser.GameObjects.Image>()
  private workLightTweens = new Map<string, Phaser.Tweens.Tween>()
  private facilityBeacons = new Map<string, Phaser.GameObjects.Image>()
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

  // --- Living-bay environment layer (Wave 8). Static per-layer Graphics
  // built once (or rebuilt only when the entity set they depend on changes),
  // never redrawn per-frame — see the "Performance" note in the Wave 8 spec.
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

  // --- Deploy cinematics (Wave 8): target reticle, dashed route line, and
  // working data-link, all keyed by companion id and torn down at the same
  // lifecycle points as the effects above.
  private walkReticles = new Map<
    string,
    { ring: Phaser.GameObjects.Graphics; tween: Phaser.Tweens.Tween | null }
  >()
  private routeLines = new Map<string, Phaser.GameObjects.Graphics>()
  private dataLinks = new Map<
    string,
    {
      facilityId: string
      line: Phaser.GameObjects.Graphics
      packets: Phaser.GameObjects.Image[]
      tweens: Phaser.Tweens.Tween[]
    }
  >()
  /** Short-lived, self-destroying GameObjects (shockwave rings, sparks) that
   * still need tracking so a mid-animation shutdown doesn't leak them. */
  private transientEffects = new Set<Phaser.GameObjects.GameObject>()

  // --- Camera zoom/pan (Wave 8). User-driven, composed on top of the
  // resolution-derived BASE_ZOOM * renderScale in applyCameraTransform().
  private userZoom = 1
  private userPan = { x: 0, y: 0 }
  private isPanningCamera = false
  private panPointerStart = { x: 0, y: 0 }
  private panStart = { x: 0, y: 0 }
  private handleResetView = (): void => this.resetView()

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
   * that already exist: idle breathing, facility beacons, and the selection
   * ring. Per-deploy effects (walk bob/frames, working sway, foot dust) read
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
      // Ambient loops added in the living-bay pass: conduit packets, the rim
      // light chase, and drifting haze/searchlights all stop under reduced
      // motion — the conduits/apron themselves (static Graphics) stay put.
      for (const id of [...this.conduitPacketTweens.keys()]) {
        this.killTween(this.conduitPacketTweens, id)
      }
      for (const packet of this.conduitPackets.values()) packet.destroy()
      this.conduitPackets.clear()
      this.teardownRimChase()
      this.teardownAtmosphere()
      for (const [id, link] of this.dataLinks) {
        this.startDataLink(id, link.facilityId)
      }
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
      this.buildRimLights()
      this.buildAtmosphere()
      for (const [id, link] of this.dataLinks) {
        this.startDataLink(id, link.facilityId)
      }
    }
    // Redraw the selection ring so its pulse (or lack of one) matches the mode.
    if (this.selectedCompanionId) {
      this.destroySelectionRing()
      this.createSelectionRing(this.selectedCompanionId)
    }
  }

  preload(): void {
    // Loud asset-load failures — silent fallbacks to Phaser's green __DEFAULT
    // texture tile into a hexagon pattern and are very confusing.
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      console.error(`[BayScene] asset failed to load: ${file.key} → ${file.url}`)
    })

    this.load.image('ground', groundTileUrl)

    this.load.image('mech-atlas', atlasUrl)
    this.load.image('mech-marauder', marauderUrl)
    this.load.image('mech-raven', ravenUrl)
    this.load.image('mech-catapult', catapultUrl)
    this.load.image('mech-locust', locustUrl)

    for (const mechClass of Object.keys(MECH_WALK_KEY) as MechClass[]) {
      this.load.spritesheet(MECH_WALK_KEY[mechClass], MECH_WALK_URL[mechClass], {
        frameWidth: WALK_SHEET_FRAME,
        frameHeight: WALK_SHEET_FRAME
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
    this.generateSmokeTexture()
    this.drawGround()
    this.buildApron()
    this.buildRimLights()
    this.buildAtmosphere()
    if (this.state) this.render()

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
    // the pointer, and (b) the pointer barely moved (so drags don't
    // masquerade as clicks on release).
    this.input.on(
      'pointerup',
      (pointer: Phaser.Input.Pointer, currentlyOver: Phaser.GameObjects.GameObject[]) => {
        if (pointer.button === 2) return
        if (currentlyOver.length > 0) return
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
   * Mouse-wheel zoom toward the cursor, and left-drag panning on empty
   * ground. A drag that starts on an interactive sprite (mech/facility) is
   * left entirely to Phaser's own draggable system — we only start a camera
   * pan when pointerdown lands on nothing (`currentlyOver.length === 0`),
   * same guard the existing empty-tile click handler uses.
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
        if (pointer.button !== 0 || currentlyOver.length > 0) return
        this.isPanningCamera = true
        this.panPointerStart = { x: pointer.x, y: pointer.y }
        this.panStart = { ...this.userPan }
      }
    )

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
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
    })
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
   * Per-frame hook (Phaser calls this automatically every tick). The only
   * thing that needs continuous per-frame tracking is the selection ring
   * following its mech around while it walks — everything else here is
   * driven by tweens/timers instead of update().
   */
  update(): void {
    if (this.demoLayoutEnabled) this.publishDemoLayout()
    if (this.selectedCompanionId && this.selectionRing) {
      const sprite = this.mechSprites.get(this.selectedCompanionId)
      if (!sprite) return
      this.selectionRing.setPosition(sprite.x, sprite.y + MECH_DISPLAY_SIZE * 0.42)
      // Track depth too — the mech's depth is now live while it walks.
      this.selectionRing.setDepth(Math.max(1, sprite.depth - 1))
    }
  }

  private publishDemoLayout(): void {
    if (!this.demoLayoutEnabled || !this.sys.game.canvas) return

    const camera = this.cameras.main
    const canvasRect = this.sys.game.canvas.getBoundingClientRect()
    const gameSize = this.scale.gameSize
    const toPage = (sprite: Phaser.GameObjects.Image): { x: number; y: number } => {
      const canvasPoint = Phaser.GameObjects.GetCalcMatrix(sprite, camera).calc.transformPoint(0, 0)
      return canvasPointToPage(canvasPoint, canvasRect, gameSize)
    }
    const mechs = Object.fromEntries(
      [...this.mechSprites].map(([id, sprite]) => [id, toPage(sprite)])
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
   * Build a soft gray blob texture at runtime (rather than shipping a PNG)
   * — used as the particle for dead-in-field smoke. Radial gradient, white
   * core fading to transparent, recolored on emit via particleConfig.tint.
   */
  private generateSmokeTexture(): void {
    if (this.textures.exists('smoke')) return
    const size = 32
    const g = this.add.graphics({ x: 0, y: 0 })
    for (let r = size / 2; r > 0; r--) {
      const alpha = (r / (size / 2)) * 0.15
      g.fillStyle(0xffffff, alpha)
      g.fillCircle(size / 2, size / 2, r)
    }
    g.generateTexture('smoke', size, size)
    g.destroy()
  }

  /**
   * Build a small diagonal amber/black stripe texture at runtime — the
   * hazard-tile overlay. Generated once and reused (clipped per-tile by a
   * geometry mask), same pattern as generateSmokeTexture.
   */
  private generateHazardStripeTexture(): void {
    if (this.textures.exists('hazard-stripe')) return
    const size = 32
    const g = this.add.graphics({ x: 0, y: 0 })
    g.fillStyle(0x000000, 1)
    g.fillRect(0, 0, size, size)
    g.lineStyle(6, 0xefc36d, 1)
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
    const amber = Phaser.Display.Color.HexStringToColor(colors.amber).color
    const perimeterTiles: Array<{ x: number; y: number }> = []
    for (let i = 0; i < GRID_W; i += 2) perimeterTiles.push({ x: i, y: -0.5 })
    for (let i = 0; i < GRID_H; i += 2) perimeterTiles.push({ x: GRID_W - 0.5, y: i })
    for (let i = 0; i < GRID_W; i += 2) perimeterTiles.push({ x: i, y: GRID_H - 0.5 })
    for (let i = 0; i < GRID_H; i += 2) perimeterTiles.push({ x: -0.5, y: i })

    perimeterTiles.forEach((tile, index) => {
      const s = isoToScreen(tile)
      const light = this.add.image(s.x, s.y, 'smoke').setTint(amber).setScale(0.1).setDepth(1)
      this.rimLights.push(light)
      if (this.reducedMotion) {
        light.setAlpha(0.15)
        return
      }
      light.setAlpha(0.05)
      const tween = this.tweens.add({
        targets: light,
        alpha: 0.55,
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
   * corners. Entirely skipped under reduced motion — pure ambience, same
   * choice already made for facility beacons.
   */
  private buildAtmosphere(): void {
    if (this.reducedMotion) return
    if (this.hazeEmitter || this.searchlights.length > 0) return
    const center = isoToScreen({ x: GRID_W / 2, y: GRID_H / 2 })
    this.hazeEmitter = this.add
      .particles(center.x, center.y, 'smoke', {
        x: { min: -900, max: 900 },
        y: { min: -500, max: 500 },
        lifespan: 9000,
        speed: { min: 2, max: 6 },
        angle: { min: 160, max: 200 },
        alpha: { start: 0.05, end: 0 },
        scale: { start: 1.6, end: 2.4 },
        frequency: 700,
        quantity: 1,
        tint: 0x8a9484
      })
      .setDepth(2)

    const teal = Phaser.Display.Color.HexStringToColor(colors.cyan).color
    const origins: Array<[{ x: number; y: number }, number, number]> = [
      [isoToScreen({ x: -3, y: -3 }), 20, 60],
      [isoToScreen({ x: GRID_W + 2, y: GRID_H + 2 }), 200, 240]
    ]
    for (const [origin, angleFrom, angleTo] of origins) {
      const cone = this.add
        .image(origin.x, origin.y, 'smoke')
        .setTint(teal)
        .setScale(6, 2.4)
        .setAlpha(0.03)
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

  private render(): void {
    if (!this.state) return

    for (const companion of this.state.companions) {
      if (this.mechSprites.has(companion.id)) continue
      const s = isoToScreen(companion.homeTile)

      const sprite = this.add.image(
        s.x,
        s.y - MECH_DISPLAY_SIZE * 0.35,
        MECH_KEY[companion.mechClass]
      )
      sprite.setDisplaySize(MECH_DISPLAY_SIZE, MECH_DISPLAY_SIZE)
      // setDisplaySize leaves the sprite at a fractional scale (96px /
      // texture size). Every scale animation below must stay RELATIVE to
      // this base — tweening toward absolute 1.0 would stretch the mech
      // back to full texture height.
      sprite.setData('baseScaleY', sprite.scaleY)
      sprite.setData('mechClass', companion.mechClass)
      this.updateMechDepth(sprite, s.y)
      sprite.setInteractive({ draggable: true, pixelPerfect: false })
      this.input.setDraggable(sprite)

      // Track drag start position to distinguish click from drag
      let dragStartX = 0
      let dragStartY = 0
      let isDragging = false

      sprite.on('dragstart', () => {
        dragStartX = sprite.x
        dragStartY = sprite.y
        isDragging = false
      })

      sprite.on('drag', (_p: Phaser.Input.Pointer, dragX: number, dragY: number) => {
        sprite.x = dragX
        sprite.y = dragY
        this.updateMechDepth(sprite)
        // Mark as dragging if moved more than threshold
        if (Math.hypot(dragX - dragStartX, dragY - dragStartY) > CLICK_DRAG_THRESHOLD) {
          isDragging = true
        }
      })

      sprite.on('dragend', () => {
        this.handleDragEnd(companion.id, sprite)
        isDragging = false
      })

      // Use pointerup to detect clicks (not pointerdown to avoid drag conflict)
      sprite.on('pointerup', () => {
        // Only emit companionSelected if we didn't drag significantly
        if (!isDragging) {
          bus.emit('companionSelected', { companionId: companion.id })
          this.setSelectedCompanion(companion.id)
          sprite.setTint(0xffcc33)
          this.time.delayedCall(120, () => sprite.clearTint())
        }
      })

      this.mechSprites.set(companion.id, sprite)
      this.startIdleBreath(companion.id)
      this.buildHangarPad(companion.id, companion.homeTile)
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
          .text(s.x, s.y + MECH_DISPLAY_SIZE * 0.25, '⚠ NOT DEPLOYABLE', {
            fontSize: '10px',
            color: '#ff4444',
            fontFamily: 'Courier New',
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
      if (this.facilitySprites.has(facility.id)) continue
      const s = isoToScreen(facility.tile)

      const sprite = this.add.image(
        s.x,
        s.y - FACILITY_DISPLAY_H * 0.3,
        FACILITY_KEY[facility.facilityType]
      )
      sprite.setDisplaySize(FACILITY_DISPLAY_W, FACILITY_DISPLAY_H)
      sprite.setDepth(50 + s.y)
      sprite.setInteractive()
      sprite.on('pointerup', (pointer: Phaser.Input.Pointer) => {
        if (pointer.rightButtonReleased() || pointer.button === 2) {
          bus.emit('facilityRightClicked', { facilityId: facility.id })
          return
        }
        bus.emit('facilityClicked', { facilityId: facility.id })
      })
      this.facilitySprites.set(facility.id, sprite)
      this.createFacilityBeacon(facility.id, s, this.state.facilities.indexOf(facility))

      // Facility label below the sprite
      const label = this.add
        .text(s.x, s.y + FACILITY_DISPLAY_H * 0.3, facility.name.toUpperCase(), {
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
      this.facilityLabels.set(facility.id, label)
      this.buildFacilityFoundation(facility.id, facility.tile)
    }

    // Remove sprites for entities no longer in state (e.g., decommissioned facility)
    for (const [id, sprite] of this.mechSprites) {
      if (!this.state.companions.some((c) => c.id === id)) {
        this.cancelActiveWalk(id)
        sprite.destroy()
        this.mechSprites.delete(id)
        this.unavailableLabels.get(id)?.destroy()
        this.unavailableLabels.delete(id)
        this.killTween(this.idleBreathTweens, id)
        this.killTween(this.workingSwayTweens, id)
        this.footDustEmitters.get(id)?.destroy()
        this.footDustEmitters.delete(id)
        this.hangarPads.get(id)?.destroy()
        this.hangarPads.delete(id)
        this.stopDataLink(id)
        if (this.selectedCompanionId === id) {
          this.selectedCompanionId = null
          this.destroySelectionRing()
        }
      }
    }
    for (const [id, sprite] of this.facilitySprites) {
      if (!this.state.facilities.some((f) => f.id === id)) {
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
        this.facilityFoundations.get(id)?.destroy()
        this.facilityFoundations.delete(id)
        for (const [companionId, link] of this.dataLinks) {
          if (link.facilityId === id) this.stopDataLink(companionId)
        }
      }
    }
    this.rebuildConduits()
    this.publishDemoLayout()
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
      y: home.y - MECH_DISPLAY_SIZE * 0.35,
      duration: 300,
      ease: 'Back.easeOut',
      onUpdate: () => this.updateMechDepth(sprite)
    })
  }

  /**
   * Smoothly move a mech sprite to a target tile. Used for deploy walk
   * animations. Resolves when the tween completes.
   *
   * The position itself is tweened against a plain `{ t }` progress proxy
   * (not the sprite's x/y directly) so the per-frame walk bob can be
   * composed on top of the interpolated position in the same onUpdate,
   * rather than running a second tween that would fight the position
   * tween over sprite.y every frame.
   */
  walkTo(
    companionId: string,
    targetTile: { x: number; y: number },
    opts?: { facilityTile?: { x: number; y: number } }
  ): Promise<void> {
    this.cancelActiveWalk(companionId)
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return Promise.resolve()
    const target = isoToScreen(targetTile)
    const targetY = target.y - MECH_DISPLAY_SIZE * 0.35
    const startX = sprite.x
    const startY = sprite.y

    // Deploy cinematics: a dashed amber route line for every walk, plus a
    // target-lock reticle on the facility for walk-to-facility specifically
    // (walk-home has no `facilityTile`, so no reticle).
    this.showRouteLine(companionId, { x: startX, y: startY }, { x: target.x, y: targetY })
    if (opts?.facilityTile) this.showReticle(companionId, opts.facilityTile)

    sprite.setFlipX(computeFacingFlipX(sprite.flipX, target.x - startX))

    // A mech that's about to walk is no longer idle — stop the breathing
    // loop and reset scaleY so the squash tween (played on arrival) always
    // starts from a clean baseline.
    this.killTween(this.idleBreathTweens, companionId)
    sprite.scaleY = this.baseScaleY(sprite)
    this.startFootDust(companionId, sprite)

    // Swap to the 4-frame walk sheet for the duration of the walk. Guarded
    // by textures.exists so a failed sheet load degrades to the gliding
    // idle sprite instead of Phaser's green __DEFAULT texture.
    const mechClass = sprite.getData('mechClass') as MechClass | undefined
    const walkKey = mechClass ? MECH_WALK_KEY[mechClass] : undefined
    const useWalkFrames =
      !this.reducedMotion && walkKey !== undefined && this.textures.exists(walkKey)
    let currentFrame = 0
    if (useWalkFrames) this.applyMechTexture(sprite, walkKey, 0)

    // Constant ground speed → duration scales with how far the mech walks,
    // so every deploy reads as the same heavy, deliberate trudge regardless
    // of distance (a fixed duration made long walks look like a sprint).
    const walkDist = Math.hypot(target.x - startX, targetY - startY)
    const walkDuration = Phaser.Math.Clamp(
      (walkDist / WALK_SPEED_PX_PER_SEC) * 1000,
      WALK_MIN_MS,
      WALK_MAX_MS
    )

    const progress = { t: 0 }
    let resolveWalk!: () => void
    const promise = new Promise<void>((resolve) => {
      resolveWalk = resolve
    })
    const tween: Phaser.Tweens.Tween = this.tweens.add({
      targets: progress,
      t: 1,
      duration: walkDuration,
      ease: 'Sine.easeInOut',
      onUpdate: (tween) => {
        sprite.x = Phaser.Math.Linear(startX, target.x, progress.t)
        const baseY = Phaser.Math.Linear(startY, targetY, progress.t)
        // Depth from the un-bobbed base position so two mechs at the same
        // tile don't z-fight on the bob oscillation.
        this.updateMechDepth(sprite, baseY + MECH_DISPLAY_SIZE * 0.35)
        if (this.reducedMotion) {
          sprite.y = baseY
          return
        }
        if (useWalkFrames) {
          const frame = computeWalkFrame(tween.elapsed)
          if (frame !== currentFrame) {
            currentFrame = frame
            sprite.setFrame(frame)
          }
        }
        const bob = computeWalkBob(tween.elapsed)
        sprite.y = baseY + bob.yOffset
        sprite.angle = bob.angleDeg
      },
      onComplete: () => {
        sprite.x = target.x
        sprite.y = targetY
        sprite.angle = 0
        this.updateMechDepth(sprite, target.y)
        if (useWalkFrames && mechClass) this.applyMechTexture(sprite, MECH_KEY[mechClass])
        this.stopFootDust(companionId)
        this.playArrivalBurst(companionId, sprite)
        this.hideRouteLine(companionId)
        this.hideReticle(companionId, opts?.facilityTile !== undefined)
        if (this.activeWalks.get(companionId)?.tween === tween) {
          this.activeWalks.delete(companionId)
        }
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

  private cancelActiveWalk(companionId: string): void {
    const activeWalk = this.activeWalks.get(companionId)
    if (!activeWalk) return
    activeWalk.cancelled = true
    activeWalk.tween.stop()
    this.activeWalks.delete(companionId)
    this.stopFootDust(companionId)
    this.hideRouteLine(companionId)
    this.hideReticle(companionId, false)

    const sprite = this.mechSprites.get(companionId)
    const mechClass = sprite?.getData('mechClass') as MechClass | undefined
    if (sprite) {
      if (mechClass && sprite.texture.key === MECH_WALK_KEY[mechClass]) {
        this.applyMechTexture(sprite, MECH_KEY[mechClass])
      }
      sprite.angle = 0
    }
    activeWalk.resolve()
  }

  /**
   * Swap a mech sprite's texture (idle art ↔ walk sheet frame) and re-derive
   * its scale. The idle textures are ~1024px and the walk-sheet cells are
   * 256px, so the raw scale factor that produces a 96px mech differs ~4×
   * between them — setDisplaySize + re-capturing baseScaleY on EVERY swap
   * keeps all relative scale animations (breath, squash) correct. Skipping
   * the re-capture is the same bug class as the v1.1 absolute-scaleY stretch.
   */
  private applyMechTexture(
    sprite: Phaser.GameObjects.Image,
    textureKey: string,
    frame?: number
  ): void {
    sprite.setTexture(textureKey, frame)
    sprite.setDisplaySize(MECH_DISPLAY_SIZE, MECH_DISPLAY_SIZE)
    sprite.setData('baseScaleY', sprite.scaleY)
  }

  /**
   * Reactor-breathing idle loop — a barely-visible scaleY oscillation so
   * mechs standing around don't read as frozen sprites. Each mech gets a
   * random start delay so a room full of idle mechs doesn't breathe in
   * lockstep. No-op if a breath tween is already running for this mech, or
   * under prefers-reduced-motion.
   */
  private startIdleBreath(companionId: string): void {
    if (this.reducedMotion) return
    if (this.idleBreathTweens.has(companionId)) return
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return
    const tween = this.tweens.add({
      targets: sprite,
      scaleY: this.baseScaleY(sprite) * 1.008,
      duration: 1200,
      yoyo: true,
      repeat: -1,
      delay: Math.random() * 2400,
      ease: 'Sine.easeInOut'
    })
    this.idleBreathTweens.set(companionId, tween)
  }

  /**
   * Depth-sort a mech by its feet (tile screen-y), re-derived every time the
   * sprite moves — walk, drag, snap-back. Depth was previously set once at
   * creation from the HOME tile, so a mech that walked south past a facility
   * kept a stale, smaller depth than the building (facilities sort at
   * 50 + y, mechs at 100 + y): the building rendered on top AND won Phaser's
   * depth-ordered input hit-test, making the deployed mech unclickable. The
   * +100 base guarantees a mech at a facility's tile sorts in front of the
   * building, so it always stays clickable while working or dead-in-field.
   */
  private updateMechDepth(sprite: Phaser.GameObjects.Image, feetY?: number): void {
    const y = feetY ?? sprite.y + MECH_DISPLAY_SIZE * 0.35
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
    const amber = Phaser.Display.Color.HexStringToColor(colors.amber).color
    const w = TILE_W * 0.72
    const h = TILE_H * 0.72
    const g = this.add.graphics().setDepth(1)
    g.lineStyle(1, amber, 0.18)
    g.strokeEllipse(s.x, s.y, w, h)
    const corners = [
      { x: s.x, y: s.y - h / 2 },
      { x: s.x + w / 2, y: s.y },
      { x: s.x, y: s.y + h / 2 },
      { x: s.x - w / 2, y: s.y }
    ]
    g.lineStyle(2, amber, 0.4)
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
    const teal = Phaser.Display.Color.HexStringToColor(colors.cyan).color
    g.lineStyle(1, teal, 0.3)
    g.strokePoints(points, true)
    this.facilityFoundations.set(facilityId, g)
  }

  /**
   * Re-derive the power-conduit layout from the current facility set:
   * dark recessed channels (thin teal core line) from the command-center
   * facility (or the first facility if none) to every other facility, along
   * grid axes via conduitPath (bay-environment.ts). Skipped/rebuilt only
   * when the facility id/tile signature actually changes, per the
   * "redrawn only when facilities change" performance note.
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
    const teal = Phaser.Display.Color.HexStringToColor(colors.cyan).color
    for (const target of others) {
      const points = conduitPath(hub.tile, target.tile).map(isoToScreen)
      graphics.lineStyle(6, 0x000000, 0.35)
      graphics.strokePoints(points, false)
      graphics.lineStyle(1.5, teal, 0.5)
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
    const teal = Phaser.Display.Color.HexStringToColor(colors.cyan).color
    const packet = this.add
      .image(points[0].x, points[0].y, 'smoke')
      .setTint(teal)
      .setScale(0.14)
      .setAlpha(0.85)
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
   * Draw a dashed line with a single direction chevron at its midpoint —
   * used for both the walk-to-facility route and the walk-home route.
   * Straight-line dashing (not routed along conduitPath) since a mech
   * walks directly to its target, not along grid axes.
   */
  private drawDashedLine(
    g: Phaser.GameObjects.Graphics,
    from: { x: number; y: number },
    to: { x: number; y: number },
    color: number,
    alpha: number
  ): void {
    const dash = 10
    const gap = 8
    const dist = Phaser.Math.Distance.Between(from.x, from.y, to.x, to.y)
    const angle = Phaser.Math.Angle.Between(from.x, from.y, to.x, to.y)
    g.lineStyle(2, color, alpha)
    for (let d = 0; d < dist; d += dash + gap) {
      const segEnd = Math.min(d + dash, dist)
      g.lineBetween(
        from.x + Math.cos(angle) * d,
        from.y + Math.sin(angle) * d,
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

  /** Dashed amber route line from a mech's walk start to its destination. */
  private showRouteLine(
    companionId: string,
    from: { x: number; y: number },
    to: { x: number; y: number }
  ): void {
    this.hideRouteLineImmediately(companionId)
    const amber = Phaser.Display.Color.HexStringToColor(colors.amber).color
    const g = this.add.graphics().setDepth(2)
    this.drawDashedLine(g, from, to, amber, this.reducedMotion ? 0.35 : 0.55)
    this.routeLines.set(companionId, g)
  }

  private hideRouteLineImmediately(companionId: string): void {
    const g = this.routeLines.get(companionId)
    if (!g) return
    this.routeLines.delete(companionId)
    g.destroy()
  }

  /** Fade the route line out (walk completed or cancelled) rather than snapping it away. */
  private hideRouteLine(companionId: string): void {
    const g = this.routeLines.get(companionId)
    if (!g) return
    this.routeLines.delete(companionId)
    this.tweens.add({
      targets: g,
      alpha: 0,
      duration: this.reducedMotion ? 200 : 350,
      onComplete: () => g.destroy()
    })
  }

  /**
   * Rotating amber corner-bracket reticle over a facility, scaling in from
   * 1.6x to 1x — the "target lock" while a mech walks toward it. Under
   * reduced motion it's drawn once, static, at a fixed alpha.
   */
  private showReticle(companionId: string, facilityTile: { x: number; y: number }): void {
    this.hideReticleImmediately(companionId)
    const s = isoToScreen(facilityTile)
    const amber = Phaser.Display.Color.HexStringToColor(colors.amber).color
    const ring = this.add
      .graphics()
      .setPosition(s.x, s.y - FACILITY_DISPLAY_H * 0.3)
      .setDepth(60 + s.y)
    const size = FACILITY_DISPLAY_W * 0.4
    const half = size / 2
    const len = size * 0.28
    const drawBrackets = (alpha: number): void => {
      ring.clear()
      ring.lineStyle(2, amber, alpha)
      const corners: Array<[number, number, number, number]> = [
        [-half, -half, 1, 1],
        [half, -half, -1, 1],
        [half, half, -1, -1],
        [-half, half, 1, -1]
      ]
      for (const [cx, cy, dx, dy] of corners) {
        ring.lineBetween(cx, cy, cx + len * dx, cy)
        ring.lineBetween(cx, cy, cx, cy + len * dy)
      }
    }

    if (this.reducedMotion) {
      drawBrackets(0.8)
      this.walkReticles.set(companionId, { ring, tween: null })
      return
    }

    ring.setScale(1.6)
    ring.setAlpha(0)
    drawBrackets(0.85)
    const introTween = this.tweens.add({
      targets: ring,
      scale: 1,
      alpha: 0.85,
      duration: 260,
      ease: 'Quad.Out',
      onComplete: () => {
        const spinTween = this.tweens.add({
          targets: ring,
          angle: 360,
          duration: 6000,
          repeat: -1,
          ease: 'Linear'
        })
        this.walkReticles.set(companionId, { ring, tween: spinTween })
      }
    })
    this.walkReticles.set(companionId, { ring, tween: introTween })
  }

  private hideReticleImmediately(companionId: string): void {
    const entry = this.walkReticles.get(companionId)
    if (!entry) return
    this.walkReticles.delete(companionId)
    entry.tween?.stop()
    entry.ring.destroy()
  }

  /** Flash the reticle once on arrival, then fade it out (rather than snapping away). */
  private hideReticle(companionId: string, flashOnArrival: boolean): void {
    const entry = this.walkReticles.get(companionId)
    if (!entry) return
    this.walkReticles.delete(companionId)
    entry.tween?.stop()
    if (!flashOnArrival) {
      entry.ring.destroy()
      return
    }
    entry.ring.setAlpha(1)
    this.tweens.add({
      targets: entry.ring,
      alpha: 0,
      duration: this.reducedMotion ? 300 : 420,
      onComplete: () => entry.ring.destroy()
    })
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
    const teal = Phaser.Display.Color.HexStringToColor(colors.cyan).color
    const from = { x: sprite.x, y: sprite.y + MECH_DISPLAY_SIZE * 0.3 }
    const to = { x: facSprite.x, y: facSprite.y }
    const line = this.add.graphics().setDepth(Math.max(1, sprite.depth - 1))
    line.lineStyle(1, teal, this.reducedMotion ? 0.3 : 0.45)
    line.lineBetween(from.x, from.y, to.x, to.y)

    const packets: Phaser.GameObjects.Image[] = []
    const tweens: Phaser.Tweens.Tween[] = []
    if (!this.reducedMotion) {
      for (const reverse of [false, true]) {
        const packet = this.add
          .image(from.x, from.y, 'smoke')
          .setTint(teal)
          .setScale(0.1)
          .setAlpha(0.8)
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

  /**
   * Success: an expanding iso ring shockwave at the mech's feet plus a
   * short upward spark burst. Under reduced motion, a single static flash
   * instead of the expand tween/particles.
   */
  private playShockwave(companionId: string, colorHex: string): void {
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return
    const color = Phaser.Display.Color.HexStringToColor(colorHex).color
    const feetY = sprite.y + MECH_DISPLAY_SIZE * 0.42
    const ring = this.add
      .graphics()
      .setPosition(sprite.x, feetY)
      .setDepth(Math.max(1, sprite.depth - 1))
    this.transientEffects.add(ring)

    if (this.reducedMotion) {
      ring.lineStyle(3, color, 0.85)
      ring.strokeEllipse(0, 0, TILE_W * 0.6, TILE_H * 0.6)
      this.tweens.add({
        targets: ring,
        alpha: 0,
        duration: 500,
        delay: 200,
        onComplete: () => {
          this.transientEffects.delete(ring)
          ring.destroy()
        }
      })
      return
    }

    const state = { scale: 0.2, alpha: 0.9 }
    this.tweens.add({
      targets: state,
      scale: 1.6,
      alpha: 0,
      duration: 650,
      ease: 'Cubic.easeOut',
      onUpdate: () => {
        ring.clear()
        ring.lineStyle(3, color, state.alpha)
        ring.strokeEllipse(0, 0, TILE_W * 0.6 * state.scale, TILE_H * 0.6 * state.scale)
      },
      onComplete: () => {
        this.transientEffects.delete(ring)
        ring.destroy()
      }
    })

    const sparks = this.add
      .particles(sprite.x, feetY, 'smoke', {
        lifespan: 500,
        speed: { min: 40, max: 90 },
        angle: { min: 250, max: 290 },
        alpha: { start: 0.8, end: 0 },
        scale: { start: 0.18, end: 0.05 },
        tint: color,
        emitting: false
      })
      .setDepth(Math.max(1, sprite.depth - 1))
    this.transientEffects.add(sparks)
    sparks.explode(10)
    this.time.delayedCall(500, () => {
      this.transientEffects.delete(sparks)
      sparks.destroy()
    })
  }

  /** Failure: a single red ring flash at the mech's feet, no sparks. */
  private playFailureFlash(companionId: string): void {
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return
    const red = Phaser.Display.Color.HexStringToColor(colors.statusFailed).color
    const feetY = sprite.y + MECH_DISPLAY_SIZE * 0.42
    const ring = this.add
      .graphics()
      .setPosition(sprite.x, feetY)
      .setDepth(Math.max(1, sprite.depth - 1))
    ring.lineStyle(3, red, 0.9)
    ring.strokeEllipse(0, 0, TILE_W * 0.6, TILE_H * 0.6)
    this.transientEffects.add(ring)
    this.tweens.add({
      targets: ring,
      alpha: 0,
      duration: this.reducedMotion ? 500 : 350,
      delay: this.reducedMotion ? 0 : 150,
      onComplete: () => {
        this.transientEffects.delete(ring)
        ring.destroy()
      }
    })
  }

  /**
   * The sprite's resting scaleY, captured right after setDisplaySize()
   * at creation. All scale animations must be multiples of this — the
   * sprite's "natural" scale is ~0.1 (96px display / full texture size),
   * so tweening toward absolute 1.0 would stretch it ~10× vertically.
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
   * Dust puffs at the mech's feet while it walks. Reuses the single
   * 'smoke' texture (tinted warm gray) rather than a dedicated dust asset.
   * One emitter per mech, following the sprite via startFollow so it
   * doesn't need per-frame repositioning from our own code.
   */
  private startFootDust(companionId: string, sprite: Phaser.GameObjects.Image): void {
    if (this.reducedMotion) return
    this.stopFootDust(companionId)
    const feetOffsetY = MECH_DISPLAY_SIZE * 0.42
    const dust = this.add.particles(sprite.x, sprite.y + feetOffsetY, 'smoke', {
      frequency: 250,
      quantity: 1,
      lifespan: 500,
      speed: { min: 5, max: 15 },
      angle: { min: 200, max: 340 }, // biased up-and-outward in screen space
      alpha: { start: 0.5, end: 0 },
      scale: { start: 0.12, end: 0.3 },
      tint: 0x8a8578
    })
    dust.startFollow(sprite, 0, feetOffsetY)
    dust.setDepth(Math.max(1, sprite.depth - 1))
    this.footDustEmitters.set(companionId, dust)
  }

  /** Stop emitting new dust immediately; already-alive particles finish fading on their own. */
  private stopFootDust(companionId: string): void {
    const dust = this.footDustEmitters.get(companionId)
    if (!dust) return
    dust.stop()
    this.footDustEmitters.delete(companionId)
    this.time.delayedCall(500, () => dust.destroy())
  }

  /**
   * Arrival feedback: a small dust burst at the mech's feet plus a quick
   * squash-and-recover on the sprite, then hand back off to idle breathing.
   */
  private playArrivalBurst(companionId: string, sprite: Phaser.GameObjects.Image): void {
    if (!this.reducedMotion) {
      const feetOffsetY = MECH_DISPLAY_SIZE * 0.42
      const burst = this.add.particles(sprite.x, sprite.y + feetOffsetY, 'smoke', {
        lifespan: 500,
        speed: { min: 10, max: 30 },
        angle: { min: 200, max: 340 },
        alpha: { start: 0.6, end: 0 },
        scale: { start: 0.15, end: 0.35 },
        tint: 0x8a8578,
        emitting: false
      })
      burst.setDepth(Math.max(1, sprite.depth - 1))
      burst.explode(6)
      this.time.delayedCall(500, () => burst.destroy())
    }

    const base = this.baseScaleY(sprite)
    this.tweens.add({
      targets: sprite,
      scaleY: base * 0.96,
      duration: 90,
      yoyo: true,
      ease: 'Quad.Out',
      onComplete: () => {
        sprite.scaleY = base
        this.startIdleBreath(companionId)
      }
    })
  }

  /**
   * Dead-in-field: tint the mech gray, fade to 60% alpha, attach a
   * smoke emitter at its feet, and wire a single-shot click handler to
   * recover — restore full color + alpha and walk home. Called on the
   * leading edge of a `failed` transition so it fires exactly once per
   * failed deployment.
   */
  applyDeadInField(companionId: string): void {
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return

    sprite.setTint(0x666666)
    sprite.setAlpha(0.6)
    this.killTween(this.idleBreathTweens, companionId)
    sprite.scaleY = this.baseScaleY(sprite)

    const smoke = this.add.particles(sprite.x, sprite.y - 10, 'smoke', {
      speed: { min: 10, max: 30 },
      lifespan: 2000,
      alpha: { start: 0.6, end: 0 },
      scale: { start: 0.3, end: 0.9 },
      frequency: 200,
      tint: 0x555555
    })
    smoke.setDepth(sprite.depth + 1)
    this.smokeEmitters.set(companionId, smoke)

    // Disable dragging while dead — otherwise the base render() handlers
    // fire pointerup AFTER dragend and double-trigger recovery. Using
    // pointerdown for recovery also means a stray drag attempt on a dead
    // mech can't accidentally both snap-home AND walk-home.
    this.input.setDraggable(sprite, false)
    sprite.once('pointerdown', () => {
      this.clearDeadInField(companionId)
      const companion = this.state?.companions.find((c) => c.id === companionId)
      if (companion) void this.walkTo(companionId, companion.homeTile)
    })
  }

  private clearDeadInField(companionId: string): void {
    const sprite = this.mechSprites.get(companionId)
    if (sprite) {
      sprite.clearTint()
      sprite.setAlpha(1)
      this.input.setDraggable(sprite, true)
    }
    const smoke = this.smokeEmitters.get(companionId)
    if (smoke) {
      smoke.destroy()
      this.smokeEmitters.delete(companionId)
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
        color: colors.cyan
      })
      .setOrigin(0.5)
    const width = label.width + 12
    const height = label.height + 6
    const background = this.add.graphics()
    const backgroundColor = Phaser.Display.Color.HexStringToColor(colors.bgPanelDark).color
    const borderColor = Phaser.Display.Color.HexStringToColor(colors.cyan).color
    background.fillStyle(backgroundColor, 0.9)
    background.fillRoundedRect(-width / 2, -height / 2, width, height, 4)
    background.lineStyle(1, borderColor, 0.55)
    background.strokeRoundedRect(-width / 2, -height / 2, width, height, 4)

    const bubble = this.add
      .container(sprite.x, sprite.y - MECH_DISPLAY_SIZE * 0.85, [background, label])
      .setDepth(Math.max(1000, sprite.depth + 10))
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
   * Track the selected mech and (re)draw its selection ring. The mech
   * sprite's own pointerup handler calls this right after emitting
   * `companionSelected` on the bus — the bus event drives the React-side
   * stats panel, this drives the Phaser-side ring, and neither needs to
   * know about the other.
   */
  setSelectedCompanion(companionId: string): void {
    if (this.selectedCompanionId === companionId) return
    this.selectedCompanionId = companionId
    this.destroySelectionRing()
    this.createSelectionRing(companionId)
  }

  /**
   * RTS-style selection ring: a pulsing iso-perspective ellipse under the
   * mech's feet. Plays a quick expand-in on first selection, then settles
   * into an infinite alpha pulse. Under reduced motion, the ring is drawn
   * once at a fixed alpha with no pulse and no expand-in.
   */
  private createSelectionRing(companionId: string): void {
    const sprite = this.mechSprites.get(companionId)
    if (!sprite) return

    const ring = this.add.graphics()
    const cyan = Phaser.Display.Color.HexStringToColor(colors.cyan).color
    const ringW = TILE_W * 0.55
    const ringH = ringW / 2
    ring.lineStyle(2, cyan, 1)
    ring.strokeEllipse(0, 0, ringW, ringH)
    ring.setPosition(sprite.x, sprite.y + MECH_DISPLAY_SIZE * 0.42)
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
      alpha: 0.8,
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
   * "Servos active" — a slow rotation sway on the mech, plus a pulsing
   * amber work light near the target facility. Both are torn down together
   * by stopWorkingState() the moment the deployment leaves 'working'
   * (including going straight to 'failed', which also triggers
   * applyDeadInField() in the same reactToDeploymentTransitions pass).
   */
  private startWorkingState(companionId: string, facilityId: string): void {
    this.killTween(this.idleBreathTweens, companionId)
    const sprite = this.mechSprites.get(companionId)
    if (sprite) sprite.scaleY = this.baseScaleY(sprite)

    if (sprite && !this.reducedMotion) {
      const swayTween = this.tweens.add({
        targets: sprite,
        angle: 0.6,
        duration: 1600,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      })
      this.workingSwayTweens.set(companionId, swayTween)
    }

    this.startDataLink(companionId, facilityId)

    if (this.reducedMotion || this.workLights.has(facilityId)) return
    const facSprite = this.facilitySprites.get(facilityId)
    if (!facSprite) return
    const amber = Phaser.Display.Color.HexStringToColor(colors.amber).color
    const light = this.add
      .image(facSprite.x, facSprite.y - FACILITY_DISPLAY_H * 0.3, 'smoke')
      .setTint(amber)
      .setScale(0.35)
      .setAlpha(0.2)
      .setDepth(facSprite.depth + 1)
      .setBlendMode(Phaser.BlendModes.ADD)
    this.workLights.set(facilityId, light)
    const lightTween = this.tweens.add({
      targets: light,
      alpha: 0.9,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    })
    this.workLightTweens.set(facilityId, lightTween)
  }

  private stopWorkingState(companionId: string, facilityId: string): void {
    this.killTween(this.workingSwayTweens, companionId)
    const sprite = this.mechSprites.get(companionId)
    if (sprite) sprite.angle = 0
    this.startIdleBreath(companionId)
    this.stopDataLink(companionId)

    this.killTween(this.workLightTweens, facilityId)
    const light = this.workLights.get(facilityId)
    if (light) {
      light.destroy()
      this.workLights.delete(facilityId)
    }
  }

  /**
   * Tiny blinking amber beacon on every facility (working or not) so the
   * bay reads as alive even when nothing is deployed. Staggered per-facility
   * period keeps them from blinking in unison. Skipped entirely under
   * reduced motion rather than drawn static — these are pure ambience with
   * no functional meaning, unlike the selection ring.
   */
  private createFacilityBeacon(
    facilityId: string,
    screenPos: { x: number; y: number },
    index: number
  ): void {
    if (this.reducedMotion) return
    const amber = Phaser.Display.Color.HexStringToColor(colors.amber).color
    const beacon = this.add
      .image(screenPos.x, screenPos.y - FACILITY_DISPLAY_H * 0.55, 'smoke')
      .setTint(amber)
      .setScale(0.12)
      .setAlpha(0.1)
      .setDepth(50 + screenPos.y + 1)
    this.facilityBeacons.set(facilityId, beacon)
    const tween = this.tweens.add({
      targets: beacon,
      alpha: 0.8,
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
    for (const smoke of this.smokeEmitters.values()) {
      smoke.destroy()
    }
    this.smokeEmitters.clear()
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
    for (const dust of this.footDustEmitters.values()) dust.destroy()
    this.footDustEmitters.clear()
    for (const tween of this.workLightTweens.values()) tween.stop()
    this.workLightTweens.clear()
    for (const light of this.workLights.values()) light.destroy()
    this.workLights.clear()
    for (const tween of this.facilityBeaconTweens.values()) tween.stop()
    this.facilityBeaconTweens.clear()
    for (const beacon of this.facilityBeacons.values()) beacon.destroy()
    this.facilityBeacons.clear()
    for (const label of this.facilityLabels.values()) label.destroy()
    this.facilityLabels.clear()
    this.destroySelectionRing()
    this.selectedCompanionId = null

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
          this.playFailureFlash(action.companionId)
          break
        case 'completion-bubble': {
          this.playShockwave(action.companionId, colors.statusWorking)
          const deployment = next.deployments.find(
            (candidate) => candidate.id === action.deploymentId
          )
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
  }
}
