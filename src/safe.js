// Path and size guards shared by the file-fetching ops.
import { resolve, sep, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Unreadable } from './api.js';

export const FILE_CAP = 1024 * 1024;

export function checkRelPath(p) {
  const parts = p.split('/');
  if (!p || p.startsWith('/') || p.includes('\\') || parts.some((s) => s === '..' || s === '.' || s === '' || s === '.git')) {
    throw new Unreadable(`path rejected: ${p}`);
  }
  return p;
}

export function writeUnder(dest, rel, bytes) {
  checkRelPath(rel);
  const root = resolve(dest);
  const target = resolve(root, rel);
  if (!target.startsWith(root + sep)) throw new Unreadable(`path escapes dest: ${rel}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return target;
}
