/**
 * WP237（#67，Fable 定）：`read_reddit` 描述里的单价每次运行按价目表现填；取不到就不写数，只写「按条计积分」。
 *
 * 之前写死「约 0.05 积分一条」——价目表在云上，改了价描述就成了假话。
 */
import { readRedditDescription, researchToolDef } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { redditReadPrice } from '../src/research-tools.js'

describe('WP237 #67 read_reddit 的单价现填', () => {
  it('有价：写现价与默认 10 条大约多少', () => {
    const text = researchToolDef('read_reddit', { read_reddit: 0.08 })?.description ?? ''
    expect(text).toContain('现价约 0.08 积分一条')
    expect(text).toContain('约 0.8 积分')
    expect(text).toContain('不填 limit 就取 10 条')
  })

  it('没价：只说按条计积分，一个数都不编', () => {
    for (const text of [
      readRedditDescription(),
      researchToolDef('read_reddit')?.description ?? '',
    ]) {
      expect(text).toContain('按条计积分')
      expect(text).not.toMatch(/\d+(\.\d+)? 积分一条/)
      expect(text).not.toContain('0.05')
    }
    expect(researchToolDef('web_search', { web_search: 1 })).toBeUndefined()
  })

  it('三项能力同价才回那个数；价不一样或有一项查不到 → 不写数', async () => {
    const table =
      (p: Record<string, number>) =>
      async (c: string): Promise<{ credits: number } | undefined> =>
        p[c] === undefined ? undefined : { credits: p[c] as number }
    const same = {
      'social.reddit.search': 0.05,
      'social.reddit.posts': 0.05,
      'social.reddit.comments': 0.05,
    }
    expect(await redditReadPrice('read_reddit', table(same))).toBe(0.05)
    expect(
      await redditReadPrice('read_reddit', table({ ...same, 'social.reddit.comments': 0.1 })),
    ).toBeUndefined()
    expect(
      await redditReadPrice('read_reddit', table({ 'social.reddit.search': 0.05 })),
    ).toBeUndefined()
    expect(await redditReadPrice('read_reddit', async () => undefined)).toBeUndefined()
    expect(await redditReadPrice('web_search', table(same))).toBeUndefined()
  })
})
