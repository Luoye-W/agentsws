/**
 * WP411：Reddit 巡查与起草的质量闸（纯函数）。样本按 客户 10-18 那天的噪音仿写，品牌用假名 IVRA。
 */
import { describe, expect, it } from 'vitest'
import {
  contradictionHints,
  coveringTimeWindow,
  dedupeByFullname,
  externalReplyGate,
  keywordHit,
  keywordNoise,
  personaHint,
  personaViolations,
  stripUngrounded,
  ungroundedSentences,
} from '../src/index.js'

const CTX = { brand_names: ['IVRA', 'IVRA XR'], models: ['Air3', 'Go2'] }

describe('外部关键词：本地整词匹配', () => {
  it('品牌名：大小写、所有格、#、连型号都认；前缀撞上的不认', () => {
    expect(keywordHit('Just got my ivra air3 today', 'IVRA', CTX)).toBe(true)
    expect(keywordHit("IVRA's app keeps crashing", 'IVRA', CTX)).toBe(true)
    expect(keywordHit('loving #IVRA so far', 'IVRA', CTX)).toBe(true)
    expect(keywordHit('the IVRAAir3 arrived', 'IVRA', CTX)).toBe(true)
    expect(keywordHit('ivraxr is the sub', 'IVRA XR', CTX)).toBe(true)
    // 数据渠道宽松匹配撞上的：前缀、别的词
    expect(keywordHit('ivrabiliaria en Madrid', 'IVRA', CTX)).toBe(false)
    expect(keywordHit('The Ivrakan empire rose (HFY chapter 12)', 'IVRA', CTX)).toBe(false)
    // 连字符连着别的字母是另一个词；连着型号照认
    expect(keywordHit('ivra-ish tempo deck', 'IVRA', CTX)).toBe(false)
    expect(keywordHit('my IVRA-Air3 arrived', 'IVRA', CTX)).toBe(true)
    expect(keywordHit('IVRA - great glasses', 'IVRA', CTX)).toBe(true)
  })
  it('短语要整串连续出现；连字符 / 空格可有可无；中文按包含', () => {
    expect(keywordHit('Are AI glasses worth it?', 'AI glasses', CTX)).toBe(true)
    expect(keywordHit('my new AI-glasses', 'AI glasses', CTX)).toBe(true)
    expect(keywordHit('need translation help for vocabulary', 'translation glasses', CTX)).toBe(
      false,
    )
    expect(keywordHit('glasses for AI art in blender', 'AI glasses', CTX)).toBe(false)
    expect(keywordHit('这款翻译眼镜怎么样', '翻译眼镜', CTX)).toBe(true)
  })
  it('评论没提、所在帖子标题提了也算；都没提给理由', () => {
    expect(
      keywordNoise({ text: 'same here', post_title: 'IVRA Air3 overheating?' }, 'IVRA', CTX),
    ).toEqual({ keep: true })
    expect(
      keywordNoise({ title: 'Hearthstone deck', text: 'immortal combo' }, 'IVRA', CTX),
    ).toEqual({ keep: false, why: '没有整词出现「IVRA」' })
  })
})

describe('去重 / 外部帖闸', () => {
  it('同一全名只留第一份（大小写不算不同）', () => {
    const r = dedupeByFullname([
      { fullname: 't1_abc', source: 'inbox' },
      { fullname: 't1_ABC', source: 'own_sub' },
      { fullname: 't1_def', source: 'own_sub' },
    ])
    expect(r.kept.map((x) => x.source)).toEqual(['inbox', 'own_sub'])
    expect(r.dupes).toHaveLength(1)
  })
  it('个人主页、竞品版、没提到我们的都不起草', () => {
    const g = { ...CTX, competitors: ['Even Realities', 'Xreal'] }
    expect(externalReplyGate({ subreddit: 'u_PositiveConnection20', text: 'IVRA?' }, g).ok).toBe(
      false,
    )
    const rival = externalReplyGate({ subreddit: 'EvenRealities', text: 'G2 or IVRA?' }, g)
    expect(rival).toEqual({
      ok: false,
      why: 'r/EvenRealities 是竞品（Even Realities）自己的版，不去回',
    })
    expect(externalReplyGate({ subreddit: 'Smartphones', text: 'which phone?' }, g).ok).toBe(false)
    expect(
      externalReplyGate({ subreddit: 'SmartGlasses', text: 'Is the IVRA Go2 good?' }, g).ok,
    ).toBe(true)
  })
})

describe('草稿的依据、矛盾、人设', () => {
  it('没依据的技术细节认得出、换成「我去确认一下」', () => {
    const draft =
      'Thanks for flagging! This is a known display indexing issue. Switching the display language fixes it. Hope that helps.'
    const bad = ungroundedSentences(draft, ['The screen shows garbled text'])
    expect(bad).toEqual([
      'This is a known display indexing issue.',
      'Switching the display language fixes it.',
    ])
    const out = stripUngrounded(draft, bad)
    expect(out).not.toContain('indexing')
    expect(out).toContain('Let me double-check that and get back to you.')
    // 知识卡里有的就不算
    expect(ungroundedSentences('It is wireless.', ['IVRA Go2 is wireless'])).toEqual([])
    expect(ungroundedSentences("We're working on a demo video.", [])).toHaveLength(1)
  })
  it('品牌号说过「确实召回了」，草稿说「不清楚召回」→ 对不上', () => {
    const hints = contradictionHints("I can't speak to recall claims, but the Air3 is great.", [
      {
        text: 'It is true that some IVRA Air3 units were recalled due to overheating.',
        at: '2026-10-12',
      },
    ])
    expect(hints).toHaveLength(1)
    expect(hints[0]?.at).toBe('2026-10-12')
    expect(
      contradictionHints('Glad it works for you!', [{ text: 'Units were recalled.' }]),
    ).toEqual([])
  })
  it('个人口吻里不许「we / the team / DM us」；从历史发言猜口吻', () => {
    expect(personaViolations('DM us and the team will follow up.', 'personal')).toEqual(
      expect.arrayContaining(['dm us', 'the team']),
    )
    expect(personaViolations('I think the Go2 is fine.', 'personal')).toEqual([])
    const h = personaHint([
      'I used to work at IVRA, so I can share what I know.',
      'I think the Go2 is fine for daily use.',
    ])
    expect(h.stance).toBe('personal')
    expect(h.intro).toBe('I used to work at IVRA, so I can share what I know')
    expect(personaHint(['We are looking into it, our team will update.']).stance).toBe('team')
    expect(personaHint([]).stance).toBeUndefined()
  })
  it('回补时间窗 → 最小的搜索档', () => {
    const now = Date.parse('2026-10-18T00:00:00Z')
    expect(coveringTimeWindow(now - 3_600_000, now)).toBe('day')
    expect(coveringTimeWindow(Date.parse('2026-10-11T00:00:00Z'), now)).toBe('week')
    expect(coveringTimeWindow(Date.parse('2026-09-30T00:00:00Z'), now)).toBe('month')
    expect(coveringTimeWindow(Date.parse('2025-01-01T00:00:00Z'), now)).toBe('all')
  })
})
