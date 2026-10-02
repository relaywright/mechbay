import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FsNode } from '../../../shared/types'

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
 */
export function FileBrowser(props: {
  facilityPath: string
  facilityName: string
}): React.JSX.Element {
  const [tree, setTree] = useState<Record<string, FsNode[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rootErr, setRootErr] = useState<string | null>(null)

  const loadDir = useCallback(async (p: string): Promise<FsNode[] | null> => {
    try {
      return await window.mechbay.fsReadDir(p)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      return null
    }
  }, [])

  // Load root when facility changes. Reset viewer state.
  useEffect(() => {
    setTree({})
    setExpanded(new Set())
    setSelectedFile(null)
    setFileContent(null)
    setError(null)
    setRootErr(null)

    if (!props.facilityPath || props.facilityPath.length === 0) {
      setRootErr('This facility has no bound directory yet.')
      return
    }
    loadDir(props.facilityPath).then((nodes) => {
      if (nodes) setTree({ [props.facilityPath]: nodes })
      else setRootErr(`Couldn't read ${props.facilityPath}`)
    })
  }, [props.facilityPath, loadDir])

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

  async function openFile(filePath: string): Promise<void> {
    setSelectedFile(filePath)
    setFileContent(null)
    setError(null)
    try {
      const content = await window.mechbay.fsReadFile(filePath)
      setFileContent(content)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function closeFile(): void {
    setSelectedFile(null)
    setFileContent(null)
    setError(null)
  }

  const nodes = useMemo(
    () => renderNodes(props.facilityPath, tree, expanded, toggleFolder, openFile),
    [props.facilityPath, tree, expanded]
  )

  if (selectedFile) {
    return (
      <div style={paneStyle}>
        <div style={breadcrumbStyle}>
          <button type="button" onClick={closeFile} style={backButtonStyle}>
            ◂ BACK
          </button>
          <span style={filePathStyle}>{relPath(props.facilityPath, selectedFile)}</span>
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
      {rootErr && <div style={errorStyle}>⚠ {rootErr}</div>}
      {!rootErr && (
        <div style={treePaneStyle}>
          {nodes.length === 0 && !tree[props.facilityPath] ? (
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
  fontSize: 11,
  letterSpacing: '0.15em'
}

const backButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #e85f00',
  color: '#e85f00',
  fontSize: 10,
  padding: '2px 8px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  letterSpacing: '0.1em'
}

const filePathStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#888',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1
}

const treePaneStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
  fontSize: 11,
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
  fontSize: 9
}

const sizeStyle: React.CSSProperties = {
  color: '#555',
  fontSize: 10,
  marginLeft: 'auto',
  paddingLeft: 6
}

const contentStyle: React.CSSProperties = {
  background: '#0a0805',
  color: '#ccc',
  fontSize: 10,
  fontFamily: 'inherit',
  flex: 1,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  margin: 0,
  padding: 0
}

const errorStyle: React.CSSProperties = {
  color: '#f44',
  fontSize: 11,
  padding: '6px 0'
}

const mutedStyle: React.CSSProperties = {
  color: '#666',
  fontSize: 11,
  padding: '6px 0'
}
