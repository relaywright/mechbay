// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FileBrowser } from '../../src/renderer/src/components/FileBrowser'
import type { FsNode } from '../../src/shared/types'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const file = (dir: string, name: string): FsNode => ({ name, path: `${dir}/${name}`, type: 'file' })

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'mechbay')
})

describe('FileBrowser', () => {
  it('shows the current facility when an earlier facility answers last', async () => {
    const pending = { '/alpha': deferred<FsNode[]>(), '/bravo': deferred<FsNode[]>() }
    Object.assign(window, {
      mechbay: {
        fsReadDir: (path: '/alpha' | '/bravo') => pending[path].promise,
        fsReadFile: () => new Promise(() => {})
      }
    })

    const { rerender } = render(<FileBrowser facilityPath="/alpha" facilityName="alpha" />)
    rerender(<FileBrowser facilityPath="/bravo" facilityName="bravo" />)
    await act(async () => pending['/bravo'].resolve([file('/bravo', 'bravo.txt')]))
    await act(async () => pending['/alpha'].resolve([file('/alpha', 'alpha.txt')]))

    expect(screen.getByText(/bravo\.txt/)).toBeTruthy()
    expect(screen.queryByText(/alpha\.txt/)).toBeNull()
  })

  it('shows the open file when a file the user already left answers last', async () => {
    const reads = { '/site/a.txt': deferred<string>(), '/site/b.txt': deferred<string>() }
    Object.assign(window, {
      mechbay: {
        fsReadDir: () => Promise.resolve([file('/site', 'a.txt'), file('/site', 'b.txt')]),
        fsReadFile: (path: '/site/a.txt' | '/site/b.txt') => reads[path].promise
      }
    })

    render(<FileBrowser facilityPath="/site" facilityName="site" />)
    fireEvent.click(await screen.findByText('a.txt'))
    fireEvent.click(screen.getByRole('button', { name: /BACK/ }))
    fireEvent.click(await screen.findByText('b.txt'))
    await act(async () => reads['/site/b.txt'].resolve('contents of b'))
    await act(async () => reads['/site/a.txt'].resolve('contents of a'))

    expect(screen.getByText('contents of b')).toBeTruthy()
    expect(screen.queryByText('contents of a')).toBeNull()
  })

  it('explains an unlinked facility without reading the disk', () => {
    let reads = 0
    Object.assign(window, {
      mechbay: {
        fsReadDir: () => {
          reads++
          return Promise.resolve([])
        },
        fsReadFile: () => new Promise(() => {})
      }
    })
    render(<FileBrowser facilityPath="" facilityName="new-site" />)
    expect(screen.getByText(/no bound directory/i)).toBeTruthy()
    expect(reads).toBe(0)
  })
})
