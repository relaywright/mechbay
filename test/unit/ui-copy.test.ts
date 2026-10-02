import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SOURCE_ROOTS = ['src/main', 'src/preload', 'src/renderer/src', 'src/shared']
const EM_DASH = '\u2014'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [full] : []
  })
}

/**
 * String literals, template text and JSX text: everything that can reach a
 * screen, a log, or a file a person reads. Comments are not inspected.
 */
function emDashSites(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const sites: string[] = []
  const visit = (node: ts.Node): void => {
    const isText =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    if (isText && (node as ts.LiteralLikeNode).text.includes(EM_DASH)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      sites.push(`${relative(ROOT, file).replace(/\\/g, '/')}:${line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

describe('user-facing copy', () => {
  it('has no em dashes in any string the app can show, log, or write', () => {
    const sites = SOURCE_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root))).flatMap(emDashSites)
    expect(sites).toEqual([])
  })
})
