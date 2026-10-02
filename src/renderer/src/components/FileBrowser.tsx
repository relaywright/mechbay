import { useEffect, useState } from 'react'
import type { FsNode } from '../../../shared/types'
import { colors, fontSize } from '../theme'

/**
 * Read-only file browser that lives inside the sidebar's right pane.
 *
 * Two modes, single-pane:
 *   - tree  — show the directory tree rooted at facilityPath; click a folder
 *             to expand/collapse (lazy-loaded on first expand), click a file
 *             to switch to viewer mode.
 *   - file  — show the content of one selected file with a back button to
 *             return to the tree.
 *
 * Fires window.mechbay.fsReadDir / fsReadFile which delegate to the
 * whitelist-guarded FsReader in the main process. Any "Access denied"
 * errors surface inline — the component never assumes a path is readable.
 *
 * The parent keys this component by facility, so a new facility starts with
 * fresh state. Loads still guard against late responses: a slow read for an
 * earlier facility or file never overwrites the current one.
 */
export function FileBrowser(props: {
  facilityPath: string
  facilityName: string
}): React.JSX.Element {
  const { facilityPath } = props
  const unbound = facilityPath.length === 0
  const [tree, setTree] = useState<Record<string, FsNode[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rootErr, setRootErr] = useState<string | null>(null)

  async function loadDir(p: string): Promise<FsNode[] | null> {
    try {
      return await window.mechbay.fsReadDir(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }

  // Load the root listing. State is fresh per facility (parent key), so the
  // effect only loads; `cancelled` drops a response for a facility the user
  // already left.
  useEffect(() => {
    if (unbound) return
    let cancelled = false
    window.mechbay.fsReadDir(facilityPath).then(
      (nodes) => {
        if (!cancelled) setTree((prev) => ({ ...prev, [facilityPath]: nodes }))
      },
      () => {
        if (!cancelled) setRootErr(`Couldn't read ${facilityPath}`)
      }
    )
    return () => {
      cancelled = true
    }
  }, [facilityPath, unbound])

  // Read the selected file. Closing it or opening another cancels the read,
  // so only the file on screen can fill the viewer.
  useEffect(() => {
    if (selectedFile === null) return
    let cancelled = false
    window.mechbay.fsReadFile(selectedFile).then(
      (content) => {
        if (!cancelled) setFileContent(content)
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [selectedFile])

  async function toggleFolder(dirPath: string): Promise<void> {
    if (expanded.has(dirPath)) {
      const next = new Set(expanded)
      next.delete(dirPath)
      setExpanded(next)
      return
    }
    if (!tree[dirPath]) {
      const nodes = await loadDir(dirPath)
      if (!nodes) return
      setTree((prev) => ({ ...prev, [dirPath]: nodes }))
    }
    setExpanded((prev) => new Set(prev).add(dirPath))
  }

  function openFile(filePath: string): void {
    setSelectedFile(filePath)
    setFileContent(null)
    setError(null)
  }

  function closeFile(): void {
    setSelectedFile(null)
    setFileContent(null)
    setError(null)
  }

  // Cheap to rebuild each render; memoizing it captured stale handlers.
  const nodes = renderNodes(facilityPath, tree, expanded, toggleFolder, openFile)

  if (selectedFile) {
    return (
      <div style={paneStyle}>
        <div style={breadcrumbStyle}>
          <button type="button" onClick={closeFile} style={backButtonStyle}>
            ◂ BACK
          </button>
          <span style={filePathStyle}>{relPath(facilityPath, selectedFile)}</span>
        </div>
        {error && <div style={errorStyle}>⚠ {error}</div>}
        {fileContent === null && !error && <div style={mutedStyle}>Loading…</div>}
        {fileContent !== null && <pre style={contentStyle}>{fileContent}</pre>}
      </div>
    )
  }

  return (
    <div style={paneStyle}>
      <div style={breadcrumbStyle}>
        <span style={facilityLabelStyle}>📁 {props.facilityName.toUpperCase()}</span>
      </div>
      {unbound && <div style={errorStyle}>⚠ This facility has no bound directory yet.</div>}
      {!unbound && rootErr && <div style={errorStyle}>⚠ {rootErr}</div>}
      {!unbound && !rootErr && (
        <div style={treePaneStyle}>
          {nodes.length === 0 && !tree[facilityPath] ? (
            <div style={mutedStyle}>Loading…</div>
          ) : (
            nodes
          )}
        </div>
      )}
    </div>
  )
}

function renderNodes(
  rootPath: string,
  tree: Record<string, FsNode[]>,
  expanded: Set<string>,
  toggleFolder: (p: string) => void,
  openFile: (p: string) => void,
  depth: number = 0
): React.JSX.Element[] {
  const children = tree[rootPath] ?? []
  const rendered: React.JSX.Element[] = []
  for (const node of children) {
    const isExpanded = expanded.has(node.path)
    rendered.push(
      <div
        key={node.path}
        style={{ ...rowStyle, paddingLeft: 8 + depth * 14 }}
        onClick={() => (node.type === 'directory' ? toggleFolder(node.path) : openFile(node.path))}
      >
        <span style={iconStyle}>{node.type === 'directory' ? (isExpanded ? '▼' : '▶') : ' '}</span>
        <span style={{ color: node.type === 'directory' ? '#ffcc33' : '#ccc' }}>
          {node.name}
          {node.type === 'directory' ? '/' : ''}
        </span>
        {node.size !== undefined && <span style={sizeStyle}>{formatBytes(node.size)}</span>}
      </div>
    )
    if (node.type === 'directory' && isExpanded && tree[node.path]) {
      rendered.push(...renderNodes(node.path, tree, expanded, toggleFolder, openFile, depth + 1))
    }
  }
  return rendered
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10}K`
  return `${Math.round(bytes / (1024 * 102.4)) / 10}M`
}

function relPath(root: string, target: string): string {
  if (!target.startsWith(root)) return target
  const rel = target.slice(root.length)
  return rel.replace(/^[\\/]/, '') || '(root)'
}

const paneStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden'
}

const breadcrumbStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 0 8px 0',
  borderBottom: '1px dotted #2a2520',
  marginBottom: 6
}

const facilityLabelStyle: React.CSSProperties = {
  color: '#ffcc33',
  fontSize: fontSize.small,
  letterSpacing: '0.15em'
}

const backButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #e85f00',
  color: '#e85f00',
  fontSize: fontSize.small,
  padding: '2px 8px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  letterSpacing: '0.1em'
}

const filePathStyle: React.CSSProperties = {
  fontSize: fontSize.small,
  color: '#888',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1
}

const treePaneStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
  fontSize: fontSize.small,
  fontFamily: 'inherit'
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 0',
  cursor: 'pointer',
  userSelect: 'none',
  whiteSpace: 'nowrap'
}

const iconStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 10,
  color: '#e85f00',
  fontSize: fontSize.label
}

const sizeStyle: React.CSSProperties = {
  color: colors.textMuted,
  fontSize: fontSize.small,
  marginLeft: 'auto',
  paddingLeft: 6
}

const contentStyle: React.CSSProperties = {
  background: '#0a0805',
  color: '#ccc',
  fontSize: fontSize.small,
  fontFamily: 'inherit',
  flex: 1,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  margin: 0,
  padding: 0
}

const errorStyle: React.CSSProperties = {
  color: '#f44',
  fontSize: fontSize.small,
  padding: '6px 0'
}

const mutedStyle: React.CSSProperties = {
  color: colors.textMuted,
  fontSize: fontSize.small,
  padding: '6px 0'
}
