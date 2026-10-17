// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('DebriefModal for a recalled mission', () => {
  it('says the mission was recalled and shows no completion check mark', () => {
    const deployment = {
      id: 'dep-3',
      companionId: 'atlas',
      facilityId: 'reactor',
      taskPrompt: 'Migrate the sensor schema',
      status: 'cancelled',
      startedAt: 0,
      completedAt: 1000,
      summary: 'Recalled by the commander.',
      diffStats: { filesChanged: 2, insertions: 14, deletions: 3 }
    } as Deployment
    const { container } = render(
      <DebriefModal
        deployment={deployment}
        companion={{ id: 'atlas', name: 'Atlas-Prime' } as Companion}
        facility={{ id: 'reactor', name: 'Reactor Control' } as Facility}
        onDismiss={() => {}}
      />
    )
    expect(screen.getByRole('heading', { name: 'Mission recalled.' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Objective complete.' })).toBeNull()
    expect(container.querySelector('.debrief-check')).toBeNull()
  })
})

describe('DebriefModal patch export', () => {
  function renderWithFiles(): void {
    const deployment = {
      id: 'dep-4',
      companionId: 'atlas',
      facilityId: 'reactor',
      taskPrompt: 'Update the notes',
      status: 'completed',
      startedAt: 0,
      completedAt: 1000,
      exitCode: 0,
      summary: 'Completed.',
      diffStats: { filesChanged: 1, insertions: 1, deletions: 1 },
      diffFiles: [{ path: 'tracked.txt', insertions: 1, deletions: 1 }]
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

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers no export when the mission changed no files', () => {
    renderDebrief('Completed.')
    expect(screen.queryByRole('button', { name: 'COPY PATCH' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'SAVE PATCH…' })).toBeNull()
  })

  it('copies the mission patch and reports it', async () => {
    const patchExport = vi.fn().mockResolvedValue({ ok: true, outcome: 'copied' })
    vi.stubGlobal('mechbay', { patchExport, diffFileGet: vi.fn(() => new Promise(() => {})) })
    renderWithFiles()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'COPY PATCH' }))
    })

    expect(patchExport).toHaveBeenCalledWith('dep-4', 'clipboard')
    const note = screen.getByText('Patch copied to the clipboard.')
    expect(note.getAttribute('role')).toBe('status')
  })

  it('shows where a saved patch went, and surfaces an export error as an alert', async () => {
    const patchExport = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, outcome: 'saved', path: '/tmp/mission.patch' })
      .mockResolvedValueOnce({ ok: false, error: 'Facility is missing or unlinked' })
    vi.stubGlobal('mechbay', { patchExport, diffFileGet: vi.fn(() => new Promise(() => {})) })
    renderWithFiles()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'SAVE PATCH…' }))
    })
    expect(patchExport).toHaveBeenCalledWith('dep-4', 'file')
    expect(screen.getByText('Patch saved to /tmp/mission.patch').getAttribute('role')).toBe(
      'status'
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'SAVE PATCH…' }))
    })
    expect(screen.getByRole('alert').textContent).toBe('Facility is missing or unlinked')
  })
})
