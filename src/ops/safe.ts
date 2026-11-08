// Path and size guards shared by the file-fetching ops.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { Unreadable } from './api.js'

export const FILE_CAP = 1024 * 1024

export function checkRelPath(p: string): string {
  const parts = p.split('/')
  if (
    !p ||
    p.startsWith('/') ||
    p.includes('\\') ||
    parts.some((s) => s === '..' || s === '.' || s === '' || s === '.git')
  ) {
    throw new Unreadable(`path rejected: ${p}`)
  }
  return p
}

/** A ref that reaches an API path: no dot segments, no leading slash or `refs/`, no control or space characters. */
export function checkRef(r: string): string {
  const parts = r.split('/')
  if (
    !r ||
    r.startsWith('refs/') ||
    r.includes('\\') ||
    [...r].some((c) => c <= ' ' || c === '\x7f') ||
    parts.some((s) => s === '..' || s === '.' || s === '')
  ) {
    throw new Unreadable(`ref rejected: ${r}`)
  }
  return r
}

export function writeUnder(dest: string, rel: string, bytes: Uint8Array): string {
  checkRelPath(rel)
  const root = resolve(dest)
  const target = resolve(root, rel)
  if (!target.startsWith(root + sep)) throw new Unreadable(`path escapes dest: ${rel}`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return target
}

/** A branch name for an output: null unless it is free of shell metacharacters (a fork's branch name is attacker-controlled). */
export const outName = (r: unknown): string | null =>
  typeof r === 'string' && /^[A-Za-z0-9._/+@-]+$/.test(r) ? r : null
