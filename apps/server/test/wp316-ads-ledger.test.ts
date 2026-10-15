/**
 * WP316（决策 556 / 554）：广告变更账本——落盘重启还在；180 天到期按名字逐条删（还是某个账户「最近一份导出」的那份留着）；
 * 磨合期从第一件做成那天起算 14 天。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdsLedger, type LedgerEntry } from '../src/ads-wiring/ledger.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse('2026-10-15T09:00:00.000Z')
const account = { platform: 'google_ads' as const, id: '123-456-7890' }
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentsws-wp316-ledger-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const entry = (id: string, at: number, kept?: string): LedgerEntry => ({
  change_id: id,
  kind: 'pause_ad',
  platform: 'google',
  account_id: 'aa_g',
  account,
  title: '暂停',
  state: 'done',
  next: 1,
  jobs: [{ job_id: `j_${id}`, status: 'done' }],
  evidence: [],
  evidence_missing: [],
  downloads:
    kept === undefined ? [] : [{ tag: 'snapshot', name: 'x.csv', job_id: `j_${id}`, kept }],
  created_at: new Date(at).toISOString(),
  updated_at: new Date(at).toISOString(),
})

describe('广告变更账本', () => {
  it('落盘：重启之后条目、导出、磨合期起点都还在', () => {
    const dir = tmp()
    const now = { ms: T0 }
    const a = createAdsLedger({ dir, nowMs: () => now.ms })
    const kept = a.keepExport('j_1', 'snapshot', new TextEncoder().encode('Campaign\nX\n'))
    a.put(entry('chg_1', T0, kept))
    a.noteFirstDone(account, new Date(T0).toISOString())
    const b = createAdsLedger({ dir, nowMs: () => now.ms })
    expect(b.get('chg_1')?.title).toBe('暂停')
    expect(b.byJob('j_chg_1')?.change_id).toBe('chg_1')
    expect(new TextDecoder().decode(b.readExport(kept))).toBe('Campaign\nX\n')
    expect(b.breakInUntil(account)).toEqual({
      active: true,
      until: new Date(T0 + 14 * DAY).toISOString(),
    })
    now.ms = T0 + 15 * DAY
    expect(b.breakInUntil(account).active).toBe(false)
  })

  it('180 天到期逐条删，连它存的导出；还是「最近一份导出」的那份留着', () => {
    const dir = tmp()
    const now = { ms: T0 }
    const l = createAdsLedger({ dir, nowMs: () => now.ms })
    const old = l.keepExport('j_old', 'snapshot', new Uint8Array([1]))
    const latest = l.keepExport('j_latest', 'result', new Uint8Array([2]))
    l.put(entry('chg_old', T0, old))
    l.put({ ...entry('chg_latest', T0, latest) })
    l.noteLatestExport(account, latest, new Date(T0).toISOString())
    l.put(entry('chg_new', T0 + 100 * DAY))
    now.ms = T0 + 181 * DAY
    expect(l.prune()).toBe(2)
    expect(l.list().map((e) => e.change_id)).toEqual(['chg_new'])
    const files = readdirSync(join(dir, 'exports'))
    expect(files).toContain(latest)
    expect(files).not.toContain(old)
    expect(existsSync(join(dir, 'ledger.json'))).toBe(true)
  })
})
