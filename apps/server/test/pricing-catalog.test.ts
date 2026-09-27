/**
 * WP165：本机手上那一份价目（云上公开的 `/v1/pricing` + 本机缓存）。
 *
 * 钉四件事：不带令牌；刚取过 / 刚失败过不再打云；坏数据当没取到；同步读从不打网。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SAMPLE_PRICING_CATALOG } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import type { CloudFetch } from '../src/cloud.js'
import {
  createPricingCatalog,
  PRICING_CACHE_FILE,
  PRICING_FRESH_MS,
  PRICING_RETRY_MS,
} from '../src/pricing-catalog.js'

function rig(reply: () => unknown) {
  let t = Date.parse('2026-09-27T00:00:00.000Z')
  const calls: { url: string; headers: Record<string, string> }[] = []
  let down = false
  const fetch: CloudFetch = async (url, init) => {
    calls.push({ url, headers: init.headers })
    if (down) throw new Error('ECONNREFUSED')
    return { ok: true, status: 200, json: async () => ({ data: reply() }) }
  }
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-pricing-'))
  const make = () =>
    createPricingCatalog({
      clock: { now: () => new Date(t).toISOString() },
      baseUrl: 'https://cloud.test.invalid',
      fetch,
      dir,
    })
  return {
    calls,
    dir,
    make,
    advance: (ms: number) => {
      t += ms
    },
    setDown: (v: boolean) => {
      down = v
    },
  }
}

describe('本机价目', () => {
  it('打公开那条、不带令牌；刚取过就不再打；同步读从不打网', async () => {
    const r = rig(() => SAMPLE_PRICING_CATALOG)
    const catalog = r.make()
    expect(catalog.creditsFor('ai.image')).toBeUndefined()
    expect(r.calls).toHaveLength(0)
    const p = await catalog.pricing()
    expect(p.source).toBe('cloud')
    expect(r.calls[0]?.url).toBe('https://cloud.test.invalid/v1/pricing')
    expect(Object.keys(r.calls[0]?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain(
      'authorization',
    )
    await catalog.topupTiers()
    expect(r.calls).toHaveLength(1)
    expect(catalog.creditsFor('ai.image')).toBeGreaterThan(0)
    r.advance(PRICING_FRESH_MS + 1)
    await catalog.pricing()
    expect(r.calls).toHaveLength(2)
  })

  it('断网：刚失败过一分钟内不再打（不让每次点开都卡一个超时）；用上一份', async () => {
    const r = rig(() => SAMPLE_PRICING_CATALOG)
    await r.make().refresh()
    r.setDown(true)
    const catalog = r.make()
    expect((await catalog.pricing()).source).toBe('cache')
    await catalog.pricing()
    expect(r.calls).toHaveLength(2)
    r.advance(PRICING_RETRY_MS + 1)
    await catalog.pricing()
    expect(r.calls).toHaveLength(3)
  })

  it('云上回来的不像一份价目 / 缓存文件坏了：当没取到，不编数', async () => {
    const r = rig(() => ({ entries: 'nope' }))
    writeFileSync(join(r.dir, PRICING_CACHE_FILE), '{ not json')
    const catalog = r.make()
    const p = await catalog.pricing()
    expect(p.source).toBe('unavailable')
    expect(p.entries).toEqual([])
    expect((await catalog.topupTiers()).tiers).toEqual([])
  })
})
