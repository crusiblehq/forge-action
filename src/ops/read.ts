// Read ops: files, ref.
import { Unreadable, type Api } from './api.js'
import { FILE_CAP, checkRelPath, writeUnder } from './safe.js'
import { list, type OpInputs } from './shared.js'

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')

export async function files(api: Api, i: OpInputs) {
  const paths = list(i.paths ?? '')
  if (!paths.length || (!i.sha && !i.ref)) throw new Unreadable('files needs paths and sha or ref')
  if (!i.dest) throw new Unreadable('files needs dest')
  const out: Array<{ path: string; found: boolean; size?: number; sha?: string }> = []
  for (const p of paths) {
    checkRelPath(p)
    const d = await api.read(`/repos/${i.repository}/contents/${enc(p)}`, { query: { ref: i.sha || i.ref! } })
    if (d === null) {
      out.push({ path: p, found: false })
      continue
    }
    if (Array.isArray(d) || d.type !== 'file') throw new Unreadable(`not a file: ${p}`)
    if (d.size > FILE_CAP) throw new Unreadable(`${p}: ${d.size} bytes above the ${FILE_CAP} cap`)
    writeUnder(i.dest, p, Buffer.from(d.content ?? '', 'base64'))
    out.push({ path: p, found: true, size: d.size, sha: d.sha })
  }
  const ok = out.every((f) => f.found)
  return { verdict: ok ? 'ok' : 'absent', files: out, ok }
}

// ref: "heads/<branch>" or "tags/<tag>"; a bare name is a branch.
export async function ref(api: Api, i: OpInputs) {
  if (!i.ref) throw new Unreadable('ref needs ref')
  const name = /^(heads|tags)\//.test(i.ref) ? i.ref : `heads/${i.ref}`
  const d = await api.read(`/repos/${i.repository}/git/ref/${enc(name)}`)
  if (!d) return { verdict: 'absent', ok: false }
  return { verdict: 'ok', sha: d.object.sha, type: d.object.type, ok: true }
}
