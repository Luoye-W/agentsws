/**
 * WP408（决策 1155）：Amazon 联想词被拦后走用户自己的浏览器时，一批只读前 9 页（种子词本身 + a–h），
 * 其余留给下一轮（同一个种子词下一轮先读剩下的）；内置浏览器那条路不受影响。替身，不联网。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AMAZON_EXTENSION_KEYWORD_PAGES } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createAmazonKeywordBank, createKeywordStore } from '../src/amazon-keywords/index.js'
import type { AmazonAutocompleteReader } from '../src/amazon-keywords/reader.js'

const WS = 'ws_wp408'
const SEED = 'electric bike'
const letters = (from: string, to: string): string[] =>
  'abcdefghijklmnopqrstuvwxyz'
    .split('')
    .filter((c) => c >= from && c <= to)
    .map((c) => `${SEED} ${c}`)

function setup(opts: { reader?: AmazonAutocompleteReader } = {}) {
  const own: string[][] = []
  let used = 0
  let round: string[] = []
  const bank = createAmazonKeywordBank({
    workspace_id: WS,
    now: () => '2026-10-19T01:00:00.000Z',
    newId: (p) => `${p}_1`,
    reader: () => opts.reader,
    ownBrowser: () => ({
      gate: 'ok',
      suggest: async (i) => {
        round.push(i.prefix)
        return { status: 'ok', suggestions: [`${i.prefix} kit`] }
      },
      used: () => {
        used += 1
      },
    }),
    brand: async () => ({ name: 'Nordvik', markets: ['US'], competitors: [] }),
  })
  const refresh = async () => {
    round = []
    const r = await bank.refresh({ trigger: 'tool', seeds: [SEED] })
    own.push(round)
    return r.refresh.autocomplete
  }
  return { bank, own, refresh, used: () => used }
}

describe('WP408 · 联想词走你自己的浏览器只读 9 页（决策 1155）', () => {
  it('内置浏览器没有 / 被拦：你自己的浏览器只读种子词本身 + a–h，其余 18 页留给下一轮、照实说', async () => {
    expect(AMAZON_EXTENSION_KEYWORD_PAGES).toBe(9)
    const t = setup()
    const ac = await t.refresh()
    expect(t.own[0]).toEqual([SEED, ...letters('a', 'h')])
    expect(t.used()).toBe(1)
    expect(ac).toMatchObject({ planned: 27, read: 9, status: 'partial', via: 'extension' })
    expect(ac.message).toContain('只读 9 页，其余 18 页留给下一轮')
  })

  it('下一轮先读上一轮剩下的（i–q，再 r–z）；剩下的读完就清掉', async () => {
    const t = setup()
    await t.refresh()
    const second = await t.refresh()
    expect(t.own[1]).toEqual(letters('i', 'q'))
    expect(second.message).toContain('其余 9 页留给下一轮')
    const third = await t.refresh()
    expect(t.own[2]).toEqual(letters('r', 'z'))
    expect(third.read).toBe(9)
    expect(third.message ?? '').not.toContain('留给下一轮')
    // 27 页三轮读全了：第四轮从头再来
    await t.refresh()
    expect(t.own[3]).toEqual([SEED, ...letters('a', 'h')])
  })

  it('内置浏览器读得通：整批 27 页照旧，你自己的浏览器一页不开', async () => {
    const builtIn: string[] = []
    const t = setup({
      reader: {
        suggest: async (i) => {
          builtIn.push(i.prefix)
          return { status: 'ok', suggestions: [`${i.prefix} one`] }
        },
      },
    })
    const ac = await t.refresh()
    expect(builtIn).toHaveLength(27)
    expect(t.own[0]).toEqual([])
    expect(t.used()).toBe(0)
    expect(ac).toMatchObject({ planned: 27, read: 27, status: 'ok', via: 'browser' })
  })

  it('内置浏览器读了几页才被拦：你自己的浏览器接着往下读，同样至多 9 页', async () => {
    const builtIn: string[] = []
    const t = setup({
      reader: {
        suggest: async (i) => {
          builtIn.push(i.prefix)
          return builtIn.length >= 3
            ? { status: 'blocked', message: 'Amazon 出了验证页' }
            : { status: 'ok', suggestions: [`${i.prefix} one`] }
        },
      },
    })
    const ac = await t.refresh()
    expect(builtIn).toHaveLength(3)
    expect(t.own[0]).toEqual(letters('b', 'j'))
    expect(ac).toMatchObject({ planned: 27, read: 11, status: 'partial', via: 'extension' })
    expect(ac.message).toContain('其余 16 页留给下一轮')
  })

  it('「还剩哪几页」落盘：重开之后接着用；坏的那一项当没有', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp408-kw-'))
    try {
      const a = createKeywordStore(dir)
      a.update((s) => {
        s.own_browser_rest = { seed: SEED, marketplace: 'US', prefixes: letters('i', 'k') }
      })
      expect(createKeywordStore(dir).state().own_browser_rest).toEqual({
        seed: SEED,
        marketplace: 'US',
        prefixes: letters('i', 'k'),
      })
      a.update((s) => {
        ;(s as { own_browser_rest?: unknown }).own_browser_rest = { seed: 1, prefixes: 'x' }
      })
      expect(createKeywordStore(dir).state().own_browser_rest).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
