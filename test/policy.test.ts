import { describe, expect, it } from 'vitest'
import {
  MODES,
  PolicyError,
  admit,
  bypassMatch,
  capPlan,
  decide,
  globMatch,
  isPrivileged,
  parseBypassLabels,
  parseEnabledModes,
  parseLimitByLabel,
  parseMode,
  resolveMode,
  type Mode
} from '../src/policy/index.js'

describe('parseMode', () => {
  it('maps unset and blank to FULL_AHEAD', () => {
    expect(parseMode(undefined).mode).toBe('FULL_AHEAD')
    expect(parseMode('  ').mode).toBe('FULL_AHEAD')
  })
  it.each(MODES)('accepts %s', (m) => expect(parseMode(m)).toEqual({ mode: m, warnings: [] }))
  it('maps legacy values with a warning', () => {
    expect(parseMode('GREEN')).toEqual({ mode: 'FULL_AHEAD', warnings: ['legacy-mode-GREEN'] })
    expect(parseMode('YELLOW')).toEqual({ mode: 'SLOW_AHEAD', warnings: ['legacy-mode-YELLOW'] })
  })
  it('treats an unknown value as SLOW_AHEAD with a warning', () => {
    const p = parseMode('turbo')
    expect(p.mode).toBe('SLOW_AHEAD')
    expect(p.warnings[0]).toMatch(/^mode-value/)
  })
})

describe('parseEnabledModes', () => {
  it('rejects an empty list', () => expect(() => parseEnabledModes('')).toThrow(PolicyError))
  it('is case-insensitive', () => expect(parseEnabledModes('stop,full_ahead')).toEqual(['FULL_AHEAD', 'STOP']))
  it('keeps ladder order and trims', () =>
    expect(parseEnabledModes(' STOP , FULL_AHEAD')).toEqual(['FULL_AHEAD', 'STOP']))
  it('rejects an unknown token', () => expect(() => parseEnabledModes('FULL_AHEAD,FAST')).toThrow(PolicyError))
  it('rejects a list of only separators', () => expect(() => parseEnabledModes(' , ')).toThrow(PolicyError))
})

describe('resolveMode fail-safe', () => {
  const en: Mode[] = ['FULL_AHEAD', 'SLOW_AHEAD', 'STANDBY']
  it('keeps an enabled mode', () => expect(resolveMode('SLOW_AHEAD', en)).toEqual({ mode: 'SLOW_AHEAD', warnings: [] }))
  it('moves HALF_AHEAD down to SLOW_AHEAD', () => {
    const r = resolveMode('HALF_AHEAD', en)
    expect(r.mode).toBe('SLOW_AHEAD')
    expect(r.warnings).toContain('mode-not-enabled: HALF_AHEAD -> SLOW_AHEAD')
  })
  it('moves STOP to the most restrictive enabled mode', () => expect(resolveMode('STOP', en).mode).toBe('STANDBY'))
  it('keeps FULL_AHEAD for an unset variable', () => expect(resolveMode('', en).mode).toBe('FULL_AHEAD'))
  it('never loosens: STANDBY with only FULL and STOP gives STOP', () =>
    expect(resolveMode('STANDBY', ['FULL_AHEAD', 'STOP']).mode).toBe('STOP'))
  it('falls back to the most restrictive when nothing is stricter', () =>
    expect(resolveMode('DEAD_SLOW', ['FULL_AHEAD', 'HALF_AHEAD']).mode).toBe('HALF_AHEAD'))
  it('carries the invalid-value warning too', () =>
    expect(resolveMode('zzz', ['FULL_AHEAD', 'HALF_AHEAD']).warnings).toHaveLength(2))
})

describe('bypass labels', () => {
  const rules = parseBypassLabels('pod:a+priority:urgent, priority:blocker')
  it('parses OR of ANDs', () => expect(rules).toEqual([['pod:a', 'priority:urgent'], ['priority:blocker']]))
  it('requires every AND part', () => {
    expect(isPrivileged(['pod:a'], rules)).toBe(false)
    expect(isPrivileged(['priority:urgent'], rules)).toBe(false)
    expect(bypassMatch(['pod:a', 'priority:urgent'], rules)).toBe('pod:a+priority:urgent')
  })
  it('matches any OR entry', () => expect(bypassMatch(['priority:blocker'], rules)).toBe('priority:blocker'))
  it('is case-sensitive', () => expect(isPrivileged(['Priority:Blocker'], rules)).toBe(false))
  it('treats empty as nobody', () => {
    expect(parseBypassLabels('')).toEqual([])
    expect(parseBypassLabels(undefined)).toEqual([])
    expect(isPrivileged(['x'], [])).toBe(false)
  })
  it('ignores empty entries', () => expect(parseBypassLabels(', ,a,')).toEqual([['a']]))
  it.each(['pod:a+', 'a++b', '+a', ',+,a', 'c++'])('rejects the malformed entry %j', (raw) =>
    expect(() => parseBypassLabels(raw)).toThrow(PolicyError)
  )
})

const OURS = JSON.stringify([
  { label: 'pod:crusible-dev-0', modes: { HALF_AHEAD: 10, SLOW_AHEAD: 6, DEAD_SLOW: 3 } },
  { label: 'pod:*', modes: { HALF_AHEAD: 6, SLOW_AHEAD: 3, DEAD_SLOW: 1 } }
])

describe('parseLimitByLabel', () => {
  it('empty is no caps', () => expect(parseLimitByLabel('')).toEqual([]))
  it('parses ours', () => expect(parseLimitByLabel(OURS)).toHaveLength(2))
  it.each([
    ['not json', '{', /not valid JSON/],
    ['not an array', '{}', /JSON array/],
    ['entry not object', '[1]', /must be an object/],
    ['empty label', '[{"label":" ","modes":{}}]', /non-empty/],
    ['modes missing', '[{"label":"a"}]', /modes: must be an object/],
    ['modes array', '[{"label":"a","modes":[]}]', /modes: must be an object/],
    ['unknown mode', '[{"label":"a","modes":{"FAST":1}}]', /unknown mode/],
    ['negative', '[{"label":"a","modes":{"STOP":-1}}]', />= 0/],
    ['fraction', '[{"label":"a","modes":{"STOP":1.5}}]', />= 0/],
    ['string cap', '[{"label":"a","modes":{"STOP":"1"}}]', />= 0/],
    ['duplicate', '[{"label":"a","modes":{}},{"label":"a","modes":{}}]', /duplicate/]
  ])('rejects %s', (_n, raw, re) => expect(() => parseLimitByLabel(raw)).toThrow(re))
})

describe('globMatch', () => {
  it('is anchored and exact without a star', () => {
    expect(globMatch('pod:a', 'pod:a')).toBe(true)
    expect(globMatch('pod:a', 'pod:ab')).toBe(false)
  })
  it('star matches any run including none', () => {
    expect(globMatch('pod:*', 'pod:crusible-dev-1')).toBe(true)
    expect(globMatch('pod:*', 'pod:')).toBe(true)
    expect(globMatch('pod:*', 'xpod:a')).toBe(false)
  })
  it('escapes regex characters', () => {
    expect(globMatch('a.b+c', 'a.b+c')).toBe(true)
    expect(globMatch('a.b', 'axb')).toBe(false)
  })
})

describe('capPlan', () => {
  const rules = parseLimitByLabel(OURS)
  it('pod-0 uses the specific entry', () =>
    expect(capPlan(rules, ['pod:crusible-dev-0'], 'SLOW_AHEAD')).toMatchObject({
      cap: 6,
      buckets: ['pod:crusible-dev-0']
    }))
  it('other pods use the glob', () =>
    expect(capPlan(rules, ['pod:crusible-dev-1'], 'SLOW_AHEAD')).toMatchObject({ cap: 3 }))
  it('reproduces ci-mode.ts for every mode and both pods', () => {
    const want = {
      FULL_AHEAD: null,
      HALF_AHEAD: [10, 6],
      SLOW_AHEAD: [6, 3],
      DEAD_SLOW: [3, 1],
      STANDBY: null,
      STOP: null
    } as const
    for (const m of MODES) {
      const w = want[m]
      expect(capPlan(rules, ['pod:crusible-dev-0'], m)?.cap ?? null).toBe(w ? w[0] : null)
      expect(capPlan(rules, ['pod:crusible-dev-1'], m)?.cap ?? null).toBe(w ? w[1] : null)
    }
  })
  it('is uncapped without a matching label', () => expect(capPlan(rules, ['area:x'], 'SLOW_AHEAD')).toBeNull())
  it('lists every matching label as a bucket', () =>
    expect(capPlan(rules, ['pod:a', 'pod:b'], 'SLOW_AHEAD')?.buckets).toEqual(['pod:a', 'pod:b']))
  it('the first matching entry wins even when it has no cap for the mode', () => {
    const r = parseLimitByLabel('[{"label":"pod:a","modes":{}},{"label":"pod:*","modes":{"SLOW_AHEAD":1}}]')
    expect(capPlan(r, ['pod:a'], 'SLOW_AHEAD')).toBeNull()
  })
})

describe('admit (rank rule)', () => {
  it('admits the lowest numbers within the cap', () => {
    expect(admit([5, 3, 9], 9, 2)).toMatchObject({ admitted: false, rank: 3, count: 3 })
    expect(admit([5, 3, 9], 3, 2)).toMatchObject({ admitted: true, rank: 1 })
  })
  it('includes self when the search lagged', () =>
    expect(admit([], 7, 1)).toMatchObject({ admitted: true, rank: 1, count: 1 }))
  it('a cap of 0 admits nobody', () => expect(admit([], 7, 0).admitted).toBe(false))
  it('de-duplicates self', () => expect(admit([7, 8], 7, 2).count).toBe(2))
  it('two simultaneous PRs at cap 1: exactly one is admitted', () => {
    const ready = [10, 11]
    expect([admit(ready, 10, 1).admitted, admit(ready, 11, 1).admitted]).toEqual([true, false])
  })
})

describe('decide', () => {
  const base = {
    mode: 'FULL_AHEAD' as Mode,
    draft: false,
    fork: false,
    open: true,
    privileged: false,
    failfastModes: ['SLOW_AHEAD'] as Mode[]
  }
  it('skips closed, draft and fork in every mode', () => {
    for (const m of MODES) {
      expect(decide({ ...base, mode: m, open: false }).decision).toBe('skip')
      expect(decide({ ...base, mode: m, draft: true, privileged: true }).decision).toBe('skip')
      expect(decide({ ...base, mode: m, fork: true }).decision).toBe('skip')
    }
  })
  it('STOP holds even a privileged PR', () =>
    expect(decide({ ...base, mode: 'STOP', privileged: true }).decision).toBe('hold'))
  it('STANDBY holds unless privileged', () => {
    expect(decide({ ...base, mode: 'STANDBY' }).decision).toBe('hold')
    expect(decide({ ...base, mode: 'STANDBY', privileged: true }).decision).toBe('dispatch')
  })
  it.each(['FULL_AHEAD', 'HALF_AHEAD', 'SLOW_AHEAD', 'DEAD_SLOW'] as Mode[])('%s dispatches', (m) =>
    expect(decide({ ...base, mode: m }).decision).toBe('dispatch')
  )
  it('sets failfast only for failfast-modes', () => {
    expect(decide({ ...base, mode: 'SLOW_AHEAD' }).failfast).toBe(true)
    expect(decide({ ...base, mode: 'HALF_AHEAD' }).failfast).toBe(false)
  })
})
