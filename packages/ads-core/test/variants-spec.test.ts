/**
 * WP75（57 §2）：素材规格表与 A/B 变体。
 *
 * 规格表这一份**设计岗 `design.ads` 会 import**（WP76），所以形状与导出名在这里
 * 一起钉住——改了名那边会静悄悄拿不到。
 */
import { describe, expect, it } from 'vitest'
import {
  AD_CREATIVE_SPECS,
  checkAdCopy,
  checkAgainstSpec,
  creativeSpec,
  planVariants,
  specsOfPlatform,
} from '../src/index.js'

describe('AD_CREATIVE_SPECS（57 §2，设计岗读的就是它）', () => {
  it('四个平台都有规格', () => {
    for (const p of ['meta', 'google', 'x', 'tiktok'])
      expect(specsOfPlatform(p).length).toBeGreaterThan(0)
  })

  it('形状按 57 §2 那一行：platform / placement / width / height / max_duration_s? / max_text_chars? / safe_area?', () => {
    const reels = creativeSpec('meta', 'stories_reels')
    expect(reels).toMatchObject({
      platform: 'meta',
      placement: 'stories_reels',
      width: 1080,
      height: 1920,
      max_duration_s: 60,
      max_text_chars: 125,
    })
    expect(reels?.safe_area?.bottom).toBe(340)
  })

  it('文字类广告位**没有尺寸**（不编一个通用值）', () => {
    const rsa = creativeSpec('google', 'responsive_search')
    expect(rsa?.width).toBeUndefined()
    expect(rsa?.asset).toBe('text')
  })

  it('TikTok 的安全区带着一句人话（brief 上原样引用）', () => {
    expect(creativeSpec('tiktok', 'in_feed')?.safe_area?.note).toContain('点赞')
  })

  it('不认识的位回 undefined —— 不编造一条', () => {
    expect(creativeSpec('meta', 'billboard')).toBeUndefined()
  })

  it('`platform + placement` 不重复', () => {
    const keys = AD_CREATIVE_SPECS.map((s) => `${s.platform}/${s.placement}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('checkAgainstSpec', () => {
  const reels = creativeSpec('meta', 'stories_reels')

  it('尺寸 / 时长 / 字数都对得上就 ok', () => {
    if (reels === undefined) throw new Error('规格没了')
    expect(checkAgainstSpec(reels, { width: 1080, height: 1920, duration_s: 15 }).ok).toBe(true)
  })

  it('尺寸对不上 → 说出该是多少、实际是多少', () => {
    if (reels === undefined) throw new Error('规格没了')
    const r = checkAgainstSpec(reels, { width: 1080, height: 1080 })
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toContain('1080×1920')
  })

  it('给不出来的那几格不判（拿不到 ≠ 不合规）', () => {
    if (reels === undefined) throw new Error('规格没了')
    expect(checkAgainstSpec(reels, {}).ok).toBe(true)
  })

  it('中文按字算不按字节算', () => {
    if (reels === undefined) throw new Error('规格没了')
    expect(checkAgainstSpec(reels, { text: '桌'.repeat(125) }).ok).toBe(true)
    expect(checkAgainstSpec(reels, { text: '桌'.repeat(126) }).ok).toBe(false)
  })
})

describe('checkAdCopy（承诺扫描，与客服出站同一份词表）', () => {
  it('干净的文案过', () => {
    expect(checkAdCopy('桌面收纳，三档可调。').ok).toBe(true)
  })

  it('带承诺的打回，而且**不静默删改**（回的是理由不是改过的稿）', () => {
    const r = checkAdCopy('买了不满意我们可以给你退款。')
    expect(r.ok).toBe(false)
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.message).toContain('重写')
  })

  it('品牌禁用词由调用方递（公司层技能里那一份，不在这里编）', () => {
    expect(checkAdCopy('顺手清仓，走过路过', { banned_terms: ['清仓'] }).ok).toBe(false)
  })
})

describe('planVariants（一次只变一样）', () => {
  const base = {
    platform: 'meta',
    placement: 'feed_square',
    base: {
      creative_ref: 'blob_a',
      headline: '桌面收纳',
      primary_text: '三档可调，线材一次收齐。',
    },
  }

  it('每一版与基准版**只差一个维度**', () => {
    const plan = planVariants({
      ...base,
      creative_refs: ['blob_b'],
      headlines: ['一格放下所有线'],
    })
    const v1 = plan.variants.find((v) => v.axis === 'creative')
    expect(v1?.headline).toBe('桌面收纳')
    expect(v1?.primary_text).toBe('三档可调，线材一次收齐。')
    const v2 = plan.variants.find((v) => v.axis === 'headline')
    expect(v2?.creative_ref).toBe('blob_a')
  })

  it('带承诺的候选文案进不了计划，而且理由**照实摆出来**（不静默丢掉）', () => {
    const plan = planVariants({ ...base, primary_texts: ['不满意我们可以给你退款。'] })
    expect(plan.variants.filter((v) => v.axis === 'primary_text')).toHaveLength(0)
    expect(plan.rejected[0]?.reason).toContain('承诺')
  })

  it('超字数的候选也进不了（平台会截，截出来的半句话比没有更糟）', () => {
    const plan = planVariants({ ...base, headlines: ['桌'.repeat(41)] })
    expect(plan.rejected[0]?.reason).toContain('标题超了')
  })

  it('默认最多 3 版，排在后面的说清"为什么没进"', () => {
    const plan = planVariants({ ...base, creative_refs: ['b1', 'b2', 'b3', 'b4'] })
    expect(plan.variants).toHaveLength(4) // 基准 + 3
    expect(plan.rejected[0]?.reason).toContain('最多出 3 版')
  })

  it('与基准版一模一样的候选不重复出一版', () => {
    const plan = planVariants({ ...base, creative_refs: ['blob_a'] })
    expect(plan.variants).toHaveLength(1)
  })

  it('规格表里没有这个位 → 照办但明说"这一关没判"', () => {
    const plan = planVariants({ ...base, placement: 'billboard', headlines: ['x'.repeat(200)] })
    expect(plan.note).toContain('规格表里没有')
    expect(plan.variants).toHaveLength(2)
  })
})
