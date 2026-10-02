import { useEffect, useRef, useState, useCallback } from 'react'
import type { Companion, Facility } from '../../../shared/types'
import { filterPromptsFor, type QuickPrompt } from '../quickPrompts'
import { colors, type } from '../theme'

/**
 * Modal overlay that collects a task prompt before firing a deploy.
 * Replaces the Wave-1 window.prompt() call with a MechBay Ops styled
 * form — textarea + quick-prompt chips + Deploy/Cancel actions.
 *
 * Keyboard: ESC cancels. Click on the dimmed backdrop cancels.
 * Ctrl/Cmd+Enter submits when textarea is focused.
 * Disabled state: if the companion's CLI isn't available, Deploy is
 * locked and a banner explains why.
 *
 * Focus trap: Tab cycles within modal. Focus restored on close.
 */

interface DeployModalProps {
  companion: Companion
  facility: Facility
  onDeploy: (prompt: string, quickPrompt?: string) => void
  onCancel: () => void
  isLoading?: boolean
  error?: string | null
}

export function DeployModal(props: DeployModalProps): React.JSX.Element {
  const { companion, facility, onDeploy, onCancel, isLoading = false } = props

  const [text, setText] = useState('')
  const [activePromptId, setActivePromptId] = useState<string | null>(null)
  const [hoveredChip, setHoveredChip] = useState<string | null>(null)
  const [isHoveredDeploy, setIsHoveredDeploy] = useState(false)

  const modalRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const deployButtonRef = useRef<HTMLButtonElement>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)

  // Filter prompts for this mech/facility combo
  const availablePrompts = filterPromptsFor(companion.mechClass, facility.facilityType)

  // Determine deploy button state
  const hasText = text.trim().length > 0
  const cliAvailable = companion.cliAvailable
  const canDeploy = cliAvailable && hasText && !isLoading

  // Save focus on mount, restore on unmount
  useEffect(() => {
    lastFocusedRef.current = document.activeElement as HTMLElement
    // Focus the textarea on open
    textareaRef.current?.focus()

    return () => {
      lastFocusedRef.current?.focus()
    }
  }, [])

  // Keyboard handlers: ESC to cancel, Ctrl/Cmd+Enter to submit
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }

      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (canDeploy) {
          handleDeploy()
        }
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, canDeploy, text, activePromptId])

  // Focus trap: keep tab cycling within modal
  // Recomputes focusable elements on each Tab/Shift-Tab to handle dynamic content
  useEffect(() => {
    const modal = modalRef.current
    if (!modal) return

    const handleTabKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return

      // Recompute focusable elements on each keypress for dynamic content
      const focusableElements = modal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [href]:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault()
          lastElement?.focus()
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault()
          firstElement?.focus()
        }
      }
    }

    modal.addEventListener('keydown', handleTabKey)
    return () => modal.removeEventListener('keydown', handleTabKey)
  }, [])

  const handleDeploy = useCallback(() => {
    if (!canDeploy) return
    const quickPromptLabel = activePromptId
      ? availablePrompts.find((p) => p.id === activePromptId)?.label
      : undefined
    onDeploy(text.trim(), quickPromptLabel)
  }, [canDeploy, text, activePromptId, availablePrompts, onDeploy])

  const handleChipClick = useCallback(
    (prompt: QuickPrompt) => {
      if (prompt.id === 'custom') {
        // Custom: clear selection, let user type
        setActivePromptId('custom')
        textareaRef.current?.focus()
      } else {
        // Regular prompt: populate textarea
        setText(prompt.prompt)
        setActivePromptId(prompt.id)
        textareaRef.current?.focus()
      }
    },
    [setText, setActivePromptId]
  )

  const handleClearText = useCallback(() => {
    setText('')
    setActivePromptId(null)
    textareaRef.current?.focus()
  }, [setText, setActivePromptId])

  const getDeployButtonState = (): {
    style: React.CSSProperties
    text: string
    title: string
  } => {
    if (isLoading) {
      return {
        style: deployButtonLoadingStyle,
        text: 'DEPLOYING...',
        title: 'Deployment in progress'
      }
    }
    if (!cliAvailable) {
      return {
        style: deployButtonDisabledStyle,
        text: '⚠ DEPLOY',
        title: `${companion.family.toUpperCase()} CLI not found. Install it, then restart MechBay to deploy.`
      }
    }
    if (!hasText) {
      return {
        style: deployButtonDisabledStyle,
        text: '⚠ DEPLOY',
        title: 'Enter a task prompt to deploy'
      }
    }
    if (isHoveredDeploy) {
      return {
        style: deployButtonHoverStyle,
        text: '⚙ DEPLOY',
        title: 'Ctrl+Enter to deploy'
      }
    }
    return {
      style: deployButtonIdleStyle,
      text: '⚙ DEPLOY',
      title: 'Ctrl+Enter to deploy'
    }
  }

  const deployState = getDeployButtonState()

  return (
    <div
      style={backdropStyle}
      onClick={(e) => {
        if (isLoading) return
        if (e.target === e.currentTarget) onCancel()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="deploy-modal-title"
    >
      <div ref={modalRef} style={panelStyle} className="deploy-dialog">
        <div className="eyebrow">DEPLOYMENT AUTHORIZATION / BAY 01</div>
        <h2 className="dialog-heading">Give your mech a mission.</h2>
        {props.error && (
          <p role="alert" className="deploy-error">
            Deployment could not start: {props.error}
          </p>
        )}
        {/* Header */}
        <div style={headerRowStyle}>
          <div>
            <div id="deploy-modal-title" style={headerStyle}>
              DEPLOY: {companion.name.toUpperCase()} → {facility.name.toUpperCase()}
            </div>
            <div style={subheaderStyle}>
              {companion.mechClass.toUpperCase()} · {companion.family} · {facility.facilityType}
            </div>
          </div>
          {activePromptId && activePromptId !== 'custom' && (
            <button
              type="button"
              onClick={handleClearText}
              style={resetButtonStyle}
              title="Clear prompt and reset"
              aria-label="Clear prompt"
            >
              ⌫ RESET
            </button>
          )}
        </div>

        {/* CLI unavailable banner */}
        {!cliAvailable && (
          <div style={bannerStyle} role="alert">
            <span style={bannerIconStyle}>⚠</span>
            <span>
              {companion.family.toUpperCase()} CLI NOT DETECTED · install and restart to deploy
            </span>
          </div>
        )}

        {/* Quick prompt chips */}
        <div style={chipsSectionStyle}>
          <div style={chipLabelStyle}>QUICK PROMPTS</div>
          <div style={chipRowStyle}>
            {availablePrompts.map((prompt) => {
              const isActive = activePromptId === prompt.id
              const isHovered = hoveredChip === prompt.id
              return (
                <button
                  key={prompt.id}
                  type="button"
                  onClick={() => handleChipClick(prompt)}
                  onMouseEnter={() => setHoveredChip(prompt.id)}
                  onMouseLeave={() => setHoveredChip(null)}
                  style={getChipStyle(isActive, isHovered)}
                  aria-pressed={isActive}
                  aria-label={`${prompt.label} quick prompt`}
                >
                  {prompt.icon && <span style={chipIconStyle}>{prompt.icon}</span>}
                  {prompt.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Textarea */}
        <div style={textareaSectionStyle}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              // If user types, they're going custom
              if (activePromptId && activePromptId !== 'custom') {
                setActivePromptId('custom')
              }
            }}
            placeholder="Describe the task for this deployment... (Ctrl+Enter to deploy)"
            disabled={isLoading}
            style={textareaStyle}
            aria-label="Task prompt"
          />
        </div>

        {/* Action buttons */}
        <div style={actionRowStyle}>
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            style={isLoading ? cancelButtonDisabledStyle : cancelButtonStyle}
            aria-label="Cancel deployment"
          >
            CANCEL
          </button>
          <button
            ref={deployButtonRef}
            type="button"
            onClick={handleDeploy}
            disabled={!canDeploy}
            onMouseEnter={() => setIsHoveredDeploy(true)}
            onMouseLeave={() => setIsHoveredDeploy(false)}
            style={deployState.style}
            title={deployState.title}
            aria-label="Deploy mission"
          >
            {deployState.text}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Styles ---
// All colors now imported from theme.ts — single source of truth

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.7)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100
}

const panelStyle: React.CSSProperties = {
  background: colors.bgHud,
  border: `2px solid ${colors.orange}`,
  boxShadow: `0 0 32px ${colors.orangeGlow}, 0 4px 24px rgba(0, 0, 0, 0.5)`,
  padding: 24,
  width: 'min(680px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 32px)',
  overflow: 'auto',
  color: colors.orange,
  fontFamily: type.mono
}

const headerRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: 12
}

const headerStyle: React.CSSProperties = {
  fontSize: 14,
  letterSpacing: '0.12em',
  fontWeight: 'bold',
  marginBottom: 4
}

const subheaderStyle: React.CSSProperties = {
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: '0.1em'
}

const resetButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${colors.textDim}`,
  color: colors.textDim,
  padding: '4px 10px',
  fontSize: 10,
  letterSpacing: '0.1em',
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'all 0.15s ease'
}

const bannerStyle: React.CSSProperties = {
  background: '#2a1510',
  border: `1px solid ${colors.statusFailedDark}`,
  color: colors.statusFailedLight,
  padding: '10px 14px',
  fontSize: 11,
  letterSpacing: '0.08em',
  marginBottom: 16,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  borderRadius: 2
}

const bannerIconStyle: React.CSSProperties = {
  fontSize: 14
}

const chipsSectionStyle: React.CSSProperties = {
  marginBottom: 16
}

const chipLabelStyle: React.CSSProperties = {
  color: colors.amber,
  fontSize: 10,
  letterSpacing: '0.18em',
  marginBottom: 8,
  fontWeight: 'bold'
}

const chipRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8
}

const chipIconStyle: React.CSSProperties = {
  marginRight: 4,
  fontSize: 12
}

function getChipStyle(isActive: boolean, isHovered: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    background: isActive ? colors.amber : colors.borderHud,
    color: isActive ? '#000' : colors.amber,
    border: `1px solid ${colors.amber}`,
    padding: '7px 14px',
    fontSize: 11,
    letterSpacing: '0.06em',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontWeight: isActive ? 'bold' : 'normal',
    borderRadius: 16,
    transition: 'all 0.15s ease',
    display: 'flex',
    alignItems: 'center',
    boxShadow: isActive ? `0 0 8px ${colors.amberGlow}` : 'none'
  }

  if (isHovered && !isActive) {
    return {
      ...base,
      background: '#3a3520',
      boxShadow: `0 0 12px ${colors.amberGlow}`
    }
  }

  return base
}

const textareaSectionStyle: React.CSSProperties = {
  marginBottom: 20
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 120,
  background: colors.bgPanelDark,
  color: colors.textPrimary,
  border: `1px solid ${colors.borderHud}`,
  borderLeft: `3px solid ${colors.orange}`,
  padding: 12,
  fontFamily: '"Courier New", monospace',
  fontSize: 13,
  lineHeight: 1.5,
  resize: 'vertical',
  boxSizing: 'border-box',
  outline: 'none',
  transition: 'border-color 0.2s ease, box-shadow 0.2s ease'
}

// Focus styles applied via CSS-in-JS pattern with data attribute or class would be ideal,
// but for inline styles we rely on :focus-within on parent or use standard focus.
// We'll add a focus ring effect by using onFocus/onBlur if needed, but standard browser
// focus outline will apply. Let's enhance with a custom focus style via a wrapper approach.

const actionRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 12
}

const cancelButtonStyle: React.CSSProperties = {
  background: 'transparent',
  color: colors.textSecondary,
  border: `1px solid ${colors.textDim}`,
  padding: '10px 24px',
  fontSize: 12,
  letterSpacing: '0.12em',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontWeight: 'bold',
  transition: 'all 0.15s ease',
  borderRadius: 2
}

const cancelButtonDisabledStyle: React.CSSProperties = {
  ...cancelButtonStyle,
  color: colors.textDim,
  borderColor: '#3a3530',
  cursor: 'not-allowed',
  opacity: 0.6
}

const deployButtonBaseStyle: React.CSSProperties = {
  padding: '10px 28px',
  fontSize: 12,
  fontWeight: 'bold',
  letterSpacing: '0.12em',
  cursor: 'pointer',
  fontFamily: 'inherit',
  border: 'none',
  borderRadius: 2,
  transition: 'all 0.15s ease'
}

const deployButtonIdleStyle: React.CSSProperties = {
  ...deployButtonBaseStyle,
  background: colors.orange,
  color: '#000',
  boxShadow: `0 0 16px ${colors.orangeGlow}`
}

const deployButtonHoverStyle: React.CSSProperties = {
  ...deployButtonBaseStyle,
  background: colors.orangeHover,
  color: '#000',
  boxShadow: `0 0 24px rgba(255, 122, 26, 0.5)`
}

const deployButtonDisabledStyle: React.CSSProperties = {
  ...deployButtonBaseStyle,
  background: '#3a2a1a',
  color: '#555',
  cursor: 'not-allowed'
}

const deployButtonLoadingStyle: React.CSSProperties = {
  ...deployButtonBaseStyle,
  background: '#2a2015',
  color: colors.orange,
  cursor: 'wait',
  border: `1px solid ${colors.orange}`
}
