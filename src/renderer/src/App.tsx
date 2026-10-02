import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import Phaser from 'phaser'
import type { AppState, Deployment, StateHealth } from '../../shared/types'
import { BayScene } from './game/BayScene'
import { bus } from './bus'
import { DeployModal } from './components/DeployModal'
import { CrashRecoveryModal } from './components/CrashRecoveryModal'
import { StateRecoveryModal } from './components/StateRecoveryModal'
import { DebriefModal } from './components/DebriefModal'
import { FileBrowser } from './components/FileBrowser'
import { JournalTab } from './components/JournalTab'
import { BulkImportModal } from './components/BulkImportModal'
import { LogPane } from './components/LogPane'
import { CompanionPanel } from './components/CompanionPanel'
import { HudHeader } from './components/HudHeader'
import { HudFooter } from './components/HudFooter'
import { SettingsModal } from './components/SettingsModal'
import { BootSplash } from './components/BootSplash'
import { CrtOverlay } from './components/CrtOverlay'
import { CrewRoster } from './components/CrewRoster'
import { MissionBoard } from './components/MissionBoard'
import { fleetTelemetry, isActiveMission, noun, STATUS_LABELS } from './operations'
import { colors, type } from './theme'

type SidebarTab = 'operations' | 'log' | 'files' | 'journal'

function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [selectedCompanionId, setSelectedCompanionId] = useState<string | null>(null)
  const [pendingDeploy, setPendingDeploy] = useState<{
    companionId: string
    facilityId: string
  } | null>(null)
  const [recoveryZombies, setRecoveryZombies] = useState<Deployment[] | null>(null)
  const [stateHealth, setStateHealth] = useState<StateHealth | null>(null)
  const [stateNoticeDismissed, setStateNoticeDismissed] = useState(false)
  const [browsingFacilityId, setBrowsingFacilityId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<SidebarTab>('operations')
  const [demo, setDemo] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bulkImportOpen, setBulkImportOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [debriefQueue, setDebriefQueue] = useState<string[]>([])
  const [bootDone, setBootDone] = useState(false)
  const handleBootDone = useCallback(() => setBootDone(true), [])
  const dismissStateNotice = useCallback(() => setStateNoticeDismissed(true), [])

  const canvasParentRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<BayScene | null>(null)
  const gameRef = useRef<Phaser.Game | null>(null)
  const previousStateRef = useRef<AppState | null>(null)
  const latestStateRef = useRef<AppState | null>(null)

  // Subscribe to IPC state + log chunks
  useEffect(() => {
    window.mechbay
      .getState()
      .then((initialState) => {
        previousStateRef.current = initialState
        latestStateRef.current = initialState
        setState(initialState)
        setSelectedCompanionId(initialState.companions[0]?.id ?? null)
      })
      .catch((e) => setError(String(e)))
    void window.mechbay
      .getStateHealth()
      .then(setStateHealth)
      .catch((e) => console.error('[app] getStateHealth failed:', e))
    void window.mechbay
      .getAppMode()
      .then((mode) => setDemo(mode.demo))
      .catch((e) => console.error('[app] getAppMode failed:', e))
    const offState = window.mechbay.onStateChange((nextState) => {
      const previousState = previousStateRef.current
      if (previousState) {
        const completedIds = nextState.deployments
          .filter((deployment) => {
            const previousDeployment = previousState.deployments.find(
              (candidate) => candidate.id === deployment.id
            )
            return deployment.status === 'completed' && previousDeployment?.status !== 'completed'
          })
          .map((deployment) => deployment.id)

        if (completedIds.length > 0) {
          setDebriefQueue((queue) => {
            const queuedIds = new Set(queue)
            const newIds = completedIds.filter((id) => !queuedIds.has(id))
            return newIds.length > 0 ? [...queue, ...newIds] : queue
          })
        }
      }
      previousStateRef.current = nextState
      latestStateRef.current = nextState
      setState(nextState)
    })
    const offRecovery = window.mechbay.onRecoveryZombies((zombies) => setRecoveryZombies(zombies))
    return () => {
      offState()
      offRecovery()
    }
  }, [])

  // Mount Phaser once
  useEffect(() => {
    if (!canvasParentRef.current || gameRef.current) return
    const parent = canvasParentRef.current
    const scene = new BayScene()
    sceneRef.current = scene

    // Render the canvas at the window's true device-pixel resolution instead
    // of a fixed 1100×640 raster. On a maximized 4K window that fixed raster
    // was being CSS-upscaled ~3× by Scale.FIT, turning text and sprites to
    // mush. We create the game at (base × renderScale) where renderScale
    // covers the displayed width at full device DPR; BayScene scales the
    // camera zoom by the same factor so the framing is unchanged, just sharp.
    const BASE_W = 1100
    const BASE_H = 640
    const computeRenderScale = (): number => {
      const dpr = window.devicePixelRatio || 1
      const cssW = parent.clientWidth || window.innerWidth
      // Cap at 4× so an enormous display can't blow up the GPU backing store.
      return Math.min(Math.max((cssW * dpr) / BASE_W, 1), 4)
    }
    const initialScale = computeRenderScale()

    gameRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      backgroundColor: '#0a0805',
      scene,
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: Math.round(BASE_W * initialScale),
        height: Math.round(BASE_H * initialScale)
      }
    })

    // Re-render at native resolution when the window is resized/maximized.
    // Debounced to an animation frame so a drag-resize doesn't thrash the
    // WebGL backing store. setGameSize emits Phaser's RESIZE event, which
    // BayScene listens for to re-derive zoom and re-center the world.
    let resizeRaf = 0
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        const game = gameRef.current
        if (!game) return
        const scale = computeRenderScale()
        game.scale.setParentSize(parent.clientWidth, parent.clientHeight)
        game.scale.setGameSize(Math.round(BASE_W * scale), Math.round(BASE_H * scale))
      })
    })
    resizeObserver.observe(parent)
    // Automation hook: smoke scripts (Playwright-Electron) drive the scene
    // directly. Exposed only in demo mode, so a production renderer never
    // hands the Phaser scene to page scripts.
    void window.mechbay
      .getAppMode()
      .then(({ demo }) => {
        if (demo) (window as unknown as Record<string, unknown>).__mechbayScene = scene
      })
      .catch((error) => console.warn('[App] Could not resolve app mode:', error))

    const offDrop = (payload: { companionId: string; facilityId: string }): void => {
      setDeployError(null)
      setPendingDeploy(payload)
    }
    const offSelect = (payload: { companionId: string | null }): void => {
      setSelectedCompanionId(payload.companionId)
      // Keep mission preparation within reach; open the Journal explicitly.
      if (payload.companionId) {
        setActiveTab('operations')
      }
    }
    const offFacility = (payload: { facilityId: string }): void => {
      const facility = latestStateRef.current?.facilities.find(
        (candidate) => candidate.id === payload.facilityId
      )
      if (!facility) return
      if (facility.path) {
        setBrowsingFacilityId(facility.id)
        setActiveTab('files')
        return
      }
      window.mechbay
        .linkFacility(facility.id)
        .then((linkedFacility) => {
          if (linkedFacility) {
            setBrowsingFacilityId(linkedFacility.id)
            setActiveTab('files')
          }
        })
        .catch((e) =>
          alert(`Could not link building: ${e instanceof Error ? e.message : String(e)}`)
        )
    }
    const offEmptyTile = (payload: { tile: { x: number; y: number } }): void => {
      window.mechbay
        .addFacilityFromPicker(payload.tile)
        .then((facility) => {
          if (facility) {
            // Auto-open the file browser for the freshly-placed building.
            setBrowsingFacilityId(facility.id)
            setActiveTab('files')
          }
        })
        .catch((e) =>
          alert(`Could not place building: ${e instanceof Error ? e.message : String(e)}`)
        )
    }
    const offFacilityRightClick = (payload: { facilityId: string }): void => {
      const facility = latestStateRef.current?.facilities.find(
        (candidate) => candidate.id === payload.facilityId
      )
      if (
        !facility ||
        !confirm(
          `Decommission «${facility.name}»? The building is removed from the bay; the project directory on disk is untouched.`
        )
      ) {
        return
      }
      window.mechbay
        .facilityRemove(facility.id)
        .then((result) => {
          if (!result.ok) {
            alert(result.error)
            return
          }
          setBrowsingFacilityId((current) => {
            if (current !== facility.id) return current
            setActiveTab('log')
            return null
          })
        })
        .catch((e) =>
          alert(`Could not decommission building: ${e instanceof Error ? e.message : String(e)}`)
        )
    }
    bus.on('dropOnFacility', offDrop)
    bus.on('companionSelected', offSelect)
    bus.on('facilityClicked', offFacility)
    bus.on('facilityRightClicked', offFacilityRightClick)
    bus.on('emptyTileClicked', offEmptyTile)

    return () => {
      bus.off('dropOnFacility', offDrop)
      bus.off('companionSelected', offSelect)
      bus.off('facilityClicked', offFacility)
      bus.off('facilityRightClicked', offFacilityRightClick)
      bus.off('emptyTileClicked', offEmptyTile)
      resizeObserver.disconnect()
      cancelAnimationFrame(resizeRaf)
      gameRef.current?.destroy(true)
      gameRef.current = null
      sceneRef.current = null
    }
  }, [])

  // Push state into Phaser whenever it changes
  useEffect(() => {
    if (state) sceneRef.current?.setState(state)
  }, [state])

  // Hooks stay above conditional returns, including boot errors.
  const deploymentInfo = useMemo(() => {
    if (!state) return []
    const companionMap = new Map(state.companions.map((c) => [c.id, c]))
    return state.deployments.map((d) => ({
      id: d.id,
      companionName: companionMap.get(d.companionId)?.name ?? 'Unknown',
      startedAt: d.startedAt
    }))
  }, [state])

  const selectCompanion = (id: string): void => {
    setSelectedCompanionId(id)
    sceneRef.current?.setSelectedCompanion(id)
  }

  if (error) {
    return (
      <div style={shellStyle}>
        <h1>⚙ MECHBAY · BOOT ERROR</h1>
        <pre style={{ color: '#c44' }}>{error}</pre>
        {(state?.settings.crtOverlay ?? true) && <CrtOverlay />}
        {!bootDone && (
          <BootSplash
            key={state?.settings.reduceMotion ? 'reduced' : 'full'}
            reduceMotion={state?.settings.reduceMotion ?? false}
            onComplete={handleBootDone}
          />
        )}
      </div>
    )
  }

  const selectedCompanion = state?.companions.find((c) => c.id === selectedCompanionId) ?? null
  const debriefDeployment = state?.deployments.find(
    (deployment) => deployment.id === debriefQueue[0]
  )
  const debriefCompanion = state?.companions.find(
    (companion) => companion.id === debriefDeployment?.companionId
  )
  const debriefFacility = state?.facilities.find(
    (facility) => facility.id === debriefDeployment?.facilityId
  )
  // Shown once per launch; the NOT SAVING chip stays after it is dismissed.
  const showStateNotice =
    !stateNoticeDismissed &&
    stateHealth !== null &&
    (!stateHealth.ok || Boolean(stateHealth.notice))
  const otherModalOpen = Boolean(
    pendingDeploy ||
    bulkImportOpen ||
    settingsOpen ||
    showStateNotice ||
    (recoveryZombies && recoveryZombies.length > 0)
  )

  const telemetry = state && fleetTelemetry(state)
  const activeMission = state?.deployments.find(isActiveMission)
  const activeMech = state?.companions.find((c) => c.id === activeMission?.companionId)

  return (
    <div className="command-shell" data-reduce-motion={state?.settings.reduceMotion ?? false}>
      <HudHeader
        state={state}
        demo={demo}
        notSaving={stateHealth?.ok === false}
        onBulkImportClick={() => setBulkImportOpen(true)}
        onSettingsClick={() => setSettingsOpen(true)}
      />

      <main className="command-main">
        <section className="bay-sector" aria-label="Command bay">
          <div className="bay-title-row">
            <div>
              <div className="eyebrow">
                TACTICAL OVERVIEW <span>/ SECTOR 01</span>
              </div>
              <h2>
                A place for your
                <br className="compact-break" /> entire crew.
              </h2>
            </div>
            <div className="telemetry-strip" aria-label="Fleet telemetry">
              <div>
                <strong>{String(telemetry?.ready ?? 0).padStart(2, '0')}</strong>
                <span>READY</span>
              </div>
              <div>
                <strong className="amber-value">
                  {String(telemetry?.active ?? 0).padStart(2, '0')}
                </strong>
                <span>ACTIVE</span>
              </div>
              <div>
                <strong>{String(telemetry?.completed ?? 0).padStart(2, '0')}</strong>
                <span>COMPLETE</span>
              </div>
              <div>
                <strong>{String(telemetry?.queued ?? 0).padStart(2, '0')}</strong>
                <span>QUEUED</span>
              </div>
            </div>
          </div>
          <div className="bay-viewport">
            <div className="map-corner map-top-left">
              <span className="status-dot" /> ISOMETRIC FIELD <span>16 × 16</span>
              <button
                type="button"
                onClick={() => bus.emit('bayResetView')}
                style={{
                  pointerEvents: 'auto',
                  marginLeft: 12,
                  background: 'transparent',
                  color: '#9ea991',
                  border: '1px solid #404b36',
                  padding: '2px 7px',
                  font: '8px var(--mono)',
                  letterSpacing: '0.06em',
                  cursor: 'pointer'
                }}
                aria-label="Recenter the isometric field view"
              >
                RECENTER
              </button>
            </div>
            <div className="map-corner map-top-right">
              {telemetry?.linked ?? 0} {noun(telemetry?.linked ?? 0, 'PROJECT')} CONNECTED
            </div>
            <div
              ref={canvasParentRef}
              className="bay-canvas"
              aria-label="Interactive isometric bay. Use the crew and project controls for keyboard access."
            />
            <div className="map-readout">
              <span className="readout-cross" aria-hidden="true">
                ⌖
              </span>
              <div>
                <span className="eyebrow">
                  {activeMission ? 'MISSION IN PROGRESS' : 'COMMAND LINK ESTABLISHED'}
                </span>
                <strong>
                  {activeMission
                    ? `${activeMech?.name ?? 'Mech'} / ${STATUS_LABELS[activeMission.status]}`
                    : 'Awaiting your orders, Commander.'}
                </strong>
                <p>
                  {activeMission
                    ? activeMission.taskPrompt
                    : 'Drag a mech to a facility, or prepare a mission from the command panel.'}
                </p>
              </div>
              {activeMission && (
                <button className="secondary-action" onClick={() => setActiveTab('log')}>
                  Live log ↗
                </button>
              )}
            </div>
            <div className="map-scale" aria-hidden="true">
              <i />
              <span>BAY 01 / LOCAL</span>
            </div>
          </div>
          <CrewRoster
            state={state}
            selectedId={selectedCompanionId}
            onSelect={(id) => {
              selectCompanion(id)
              setActiveTab('operations')
            }}
          />
        </section>

        {/* Sidebar */}
        <aside className="command-sidebar" aria-label="Mission control">
          <div className="sidebar-heading">
            <div>
              <span className="eyebrow">COMMAND CHANNEL</span>
              <h2>Mission control</h2>
            </div>
            <span className="channel-icon" aria-hidden="true">
              ⌁
            </span>
          </div>

          <div className="sidebar-content">
            <div className="command-tabs" aria-label="Command views">
              <button
                type="button"
                className={activeTab === 'operations' ? 'active' : ''}
                aria-pressed={activeTab === 'operations'}
                onClick={() => setActiveTab('operations')}
              >
                OPERATIONS
              </button>
              <button
                type="button"
                className={activeTab === 'log' ? 'active' : ''}
                aria-pressed={activeTab === 'log'}
                onClick={() => setActiveTab('log')}
              >
                LIVE LOG
              </button>
              {browsingFacilityId && (
                <>
                  <button
                    type="button"
                    className={activeTab === 'files' ? 'active' : ''}
                    aria-pressed={activeTab === 'files'}
                    onClick={() => setActiveTab('files')}
                  >
                    FILES
                  </button>
                  <button
                    type="button"
                    className="tab-close"
                    onClick={() => {
                      setBrowsingFacilityId(null)
                      setActiveTab('log')
                    }}
                    title="Close file browser"
                  >
                    ×
                  </button>
                </>
              )}
              <button
                type="button"
                className={activeTab === 'journal' ? 'active' : ''}
                aria-pressed={activeTab === 'journal'}
                onClick={() => setActiveTab('journal')}
              >
                JOURNAL
              </button>
            </div>

            {activeTab === 'operations' && state && (
              <MissionBoard
                state={state}
                selectedId={selectedCompanionId}
                demo={demo}
                onSelect={selectCompanion}
                onDeploy={(companionId, facilityId) => {
                  setDeployError(null)
                  setPendingDeploy({ companionId, facilityId })
                }}
                onReview={(id) =>
                  setDebriefQueue((queue) => [id, ...queue.filter((item) => item !== id)])
                }
                onFacility={(facilityId) => bus.emit('facilityClicked', { facilityId })}
                onJournal={() => setActiveTab('journal')}
                onLog={() => setActiveTab('log')}
              />
            )}

            {activeTab === 'log' && (
              <LogPane logs={state?.logChunks ?? []} deployments={deploymentInfo} />
            )}

            {activeTab === 'files' &&
              browsingFacilityId &&
              state &&
              (() => {
                const facility = state.facilities.find((f) => f.id === browsingFacilityId)
                if (!facility)
                  return <div style={{ color: colors.textSecondary }}>Facility not found.</div>
                return (
                  <FileBrowser
                    key={`${facility.id}:${facility.path}`}
                    facilityPath={facility.path}
                    facilityName={facility.name}
                  />
                )
              })()}

            {activeTab === 'journal' && (
              <div className="journal-scroll">
                <CompanionPanel
                  companion={selectedCompanion}
                  deployments={state?.deployments ?? []}
                  facilities={state?.facilities ?? []}
                />
                <JournalTab key={selectedCompanionId ?? 'none'} companionId={selectedCompanionId} />
              </div>
            )}
          </div>
        </aside>
      </main>

      <HudFooter />

      {recoveryZombies && recoveryZombies.length > 0 && (
        <CrashRecoveryModal zombies={recoveryZombies} onDismiss={() => setRecoveryZombies(null)} />
      )}

      {stateHealth && showStateNotice && (
        <StateRecoveryModal health={stateHealth} onDismiss={dismissStateNotice} />
      )}

      {bulkImportOpen && <BulkImportModal onClose={() => setBulkImportOpen(false)} />}

      {settingsOpen && state && (
        <SettingsModal
          companions={state.companions}
          reduceMotion={state.settings.reduceMotion ?? false}
          crtOverlay={state.settings.crtOverlay ?? true}
          missionAlerts={state.settings.missionAlerts ?? true}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {!otherModalOpen && debriefDeployment && debriefCompanion && debriefFacility && (
        <DebriefModal
          deployment={debriefDeployment}
          companion={debriefCompanion}
          facility={debriefFacility}
          onDismiss={() => setDebriefQueue((queue) => queue.slice(1))}
        />
      )}

      {pendingDeploy &&
        state &&
        (() => {
          const companion = state.companions.find((c) => c.id === pendingDeploy.companionId)
          const facility = state.facilities.find((f) => f.id === pendingDeploy.facilityId)
          if (!companion || !facility) {
            // State drifted (rare) — just dismiss.
            setPendingDeploy(null)
            return null
          }
          return (
            <DeployModal
              companion={companion}
              facility={facility}
              isLoading={deploying}
              error={deployError}
              onCancel={() => {
                if (!deploying) setPendingDeploy(null)
              }}
              onDeploy={(prompt, quickPrompt) => {
                setDeploying(true)
                setDeployError(null)
                window.mechbay
                  .deployStart({
                    companionId: pendingDeploy.companionId,
                    facilityId: pendingDeploy.facilityId,
                    taskPrompt: prompt,
                    quickPromptUsed: quickPrompt
                  })
                  .then(() => {
                    setPendingDeploy(null)
                    setActiveTab('log')
                  })
                  .catch((e) => setDeployError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setDeploying(false))
              }}
            />
          )
        })()}
      {(state?.settings.crtOverlay ?? true) && <CrtOverlay />}
      {!bootDone && (
        <BootSplash
          key={state?.settings.reduceMotion ? 'reduced' : 'full'}
          reduceMotion={state?.settings.reduceMotion ?? false}
          onComplete={handleBootDone}
        />
      )}
    </div>
  )
}

const shellStyle: React.CSSProperties = {
  fontFamily: type.mono,
  color: colors.orange,
  background: colors.bgPanelDark,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  fontSize: 14
}

export default App
