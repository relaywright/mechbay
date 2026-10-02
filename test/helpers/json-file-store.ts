import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { StoreLike } from '../../src/main/state-manager'

/**
 * A StoreLike backed by a real JSON file, read and written the way
 * electron-store 10 (conf 14) does: the whole object, tab-indented. Lets
 * the migration guard compare files byte for byte.
 */
export class JsonFileStore implements StoreLike {
  constructor(readonly path: string) {}

  private read(): Record<string, unknown> {
    if (!existsSync(this.path)) return {}
    return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
  }

  get(key: string): unknown {
    return this.read()[key]
  }

  has(key: string): boolean {
    return key in this.read()
  }

  set(key: string, value: unknown): void {
    writeFileSync(this.path, JSON.stringify({ ...this.read(), [key]: value }, undefined, '\t'))
  }
}
