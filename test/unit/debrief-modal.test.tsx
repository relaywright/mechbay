// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DebriefModal } from '../../src/renderer/src/components/DebriefModal'
import type { Companion, Deployment, Facility } from '../../src/shared/types'

afterEach(cleanup)

function renderDebrief(summary: string): void {
  const deployment = {
    id: 'dep-1',
    companionId: 'atlas',
    facilityId: 'reactor',
    taskPrompt: 'Tighten the sensor thresholds',
    status: 'completed',
    startedAt: 0,
    completedAt: 1000,
    exitCode: 0,
    summary
  } as Deployment
  render(
    <DebriefModal
      deployment={deployment}
      companion={{ id: 'atlas', name: 'Atlas-Prime' } as Companion}
      facility={{ id: 'reactor', name: 'Reactor Control' } as Facility}
      onDismiss={() => {}}
    />
  )
}

describe('DebriefModal without a file diff', () => {
  // Task 5b refuses to read some real repos (unsafe git config, a timeout on
  // a large repo). The panel must not contradict the summary by claiming
  // there is no repository; the summary carries the real reason.
  it('defers to the summary instead of claiming there is no repository', () => {
    renderDebrief('Completed. The diff is unavailable because git could not read this project.')

    expect(screen.queryByText(/no git repository/i)).toBeNull()
    expect(screen.getByText('File diff unavailable. The summary above says why.')).toBeTruthy()
  })

  it('still reads correctly for a project with no repository', () => {
    renderDebrief('Completed. (No git repository, so no diff is available.)')

    expect(screen.getAllByText(/no git repository/i)).toHaveLength(1)
    expect(screen.getByText('File diff unavailable. The summary above says why.')).toBeTruthy()
  })
})

describe('DebriefModal blocked actions', () => {
  function renderBlocked(autonomy: Deployment['autonomy']): void {
    const deployment = {
      id: 'dep-2',
      companionId: 'atlas',
      facilityId: 'reactor',
      taskPrompt: 'Clean the build',
      status: 'completed',
      startedAt: 0,
      completedAt: 1000,
      exitCode: 0,
      summary: 'Completed.',
      autonomy,
      permissionDenials: ['Bash: rm -rf build']
    } as Deployment
    render(
      <DebriefModal
        deployment={deployment}
        companion={{ id: 'atlas', name: 'Atlas-Prime' } as Companion}
        facility={{ id: 'reactor', name: 'Reactor Control' } as Facility}
        onDismiss={() => {}}
      />
    )
  }

  it('suggests raising Autonomy when the mission ran below Full', () => {
    renderBlocked('edit')
    expect(screen.getByText(/raise this mech’s Autonomy/)).toBeTruthy()
  })

  it.each(['full', 'unenforced'] as const)(
    'points at CLI rules instead when it ran at %s',
    (autonomy) => {
      renderBlocked(autonomy)
      expect(screen.queryByText(/raise this mech’s Autonomy/)).toBeNull()
      expect(screen.getByText(/allow and deny rules in your CLI settings/)).toBeTruthy()
    }
  )
})
