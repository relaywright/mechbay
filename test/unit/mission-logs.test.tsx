// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareLogChunks,
  mergeLogChunks,
  useMissionLogs
} from '../../src/renderer/src/mission-logs'
import type { Deployment, LogChunk } from '../../src/shared/types'

const entry = (deploymentId: string, seq: number, timestamp: number): LogChunk => ({
  id: `${deploymentId}:${seq}`,
  deploymentId,
  seq,
  timestamp,
  stream: 'stdout',
  text: `${deploymentId}-${seq}`
})

describe('mergeLogChunks', () => {
  it('dedupes by id and orders by time, mission, then sequence', () => {
    const merged = mergeLogChunks(
      [entry('b', 1, 5), entry('a', 2, 5)],
      [entry('a', 1, 5), entry('b', 1, 5), entry('a', 3, 1)]
    )
    expect(merged.map((e) => e.id)).toEqual(['a:3', 'a:1', 'a:2', 'b:1'])
    expect([...merged].sort(compareLogChunks)).toEqual(merged)
  })

  it('keeps only the newest entries past the cap', () => {
    const merged = mergeLogChunks([], [entry('a', 1, 1), entry('a', 2, 2), entry('a', 3, 3)], 2)
    expect(merged.map((e) => e.seq)).toEqual([2, 3])
  })

  it('returns the same array when nothing new arrived', () => {
    const current = [entry('a', 1, 1)]
    expect(mergeLogChunks(current, [entry('a', 1, 1)])).toBe(current)
  })
})

describe('useMissionLogs', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('subscribes before fetching history, so no line is lost in between', async () => {
    let push: ((entries: LogChunk[]) => void) | null = null
    const calls: string[] = []
    vi.stubGlobal(
      'window',
      Object.assign(window, {
        mechbay: {
          logs: {
            subscribe: (cb: (entries: LogChunk[]) => void) => {
              calls.push('subscribe')
              push = cb
              return () => {}
            },
            history: async (id: string) => {
              calls.push(`history:${id}`)
              return [entry(id, 1, 1)]
            }
          }
        }
      })
    )
    const deployments = [{ id: 'm1', startedAt: 1 }] as Deployment[]
    const { result } = renderHook(() => useMissionLogs(deployments))
    act(() => push?.([entry('m1', 2, 2)]))
    await waitFor(() => expect(result.current.map((e) => e.id)).toEqual(['m1:1', 'm1:2']))
    expect(calls[0]).toBe('subscribe')
  })

  it('fetches history once per recent mission, newest five only', async () => {
    const asked: string[] = []
    vi.stubGlobal(
      'window',
      Object.assign(window, {
        mechbay: {
          logs: {
            subscribe: () => () => {},
            history: async (id: string) => {
              asked.push(id)
              return []
            }
          }
        }
      })
    )
    const deployments = Array.from({ length: 7 }, (_, i) => ({
      id: `m${i}`,
      startedAt: i
    })) as Deployment[]
    const { rerender } = renderHook(({ list }) => useMissionLogs(list), {
      initialProps: { list: deployments }
    })
    rerender({ list: [...deployments] })
    await waitFor(() => expect(asked.sort()).toEqual(['m2', 'm3', 'm4', 'm5', 'm6']))
  })

  it('logs a history failure instead of throwing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'window',
      Object.assign(window, {
        mechbay: {
          logs: {
            subscribe: () => () => {},
            history: async () => {
              throw new Error('Invalid mission id')
            }
          }
        }
      })
    )
    const { result } = renderHook(() =>
      useMissionLogs([{ id: 'm1', startedAt: 1 }] as Deployment[])
    )
    await waitFor(() => expect(errors).toHaveBeenCalled())
    expect(result.current).toEqual([])
  })
})
