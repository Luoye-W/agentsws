/**
 * WP404（docs/107 §4）：persona 的用户改写从「按语言整段替换」改成「按语言、按段」。
 *
 * 钉三件事：拆段与拼回逐字节（全部内置 persona × 中英）；按段存的改写叠出来的与整段替换时一模一样
 * （行为不变）；包里出新版时，没改过的段跟着新版走、改过的段留着用户的（回落 / 不冲掉）。
 */
import type { PersonaText } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  applyPersonaOverride,
  applyPersonaSectionOverride,
  joinPersonaSections,
  loadBundledPositions,
  loadBundledRoles,
  overriddenPersonaSections,
  PERSONA_SECTION_IDS,
  personaSectionDiff,
  personaTextIn,
  personaView,
  splitPersonaSections,
} from '../src/index.js'

const all = (): { key: string; persona: PersonaText | undefined }[] => [
  ...loadBundledRoles().map((r) => ({ key: `role:${r.id}`, persona: r.persona })),
  ...loadBundledPositions().map((p) => ({ key: `position:${p.id}`, persona: p.persona })),
]

const PACKAGED = {
  zh: '你是谁：甲。\n你负责：乙。\n你不负责：丙。\n怎么做：丁。\n口气：戊。\n必须出卡：己。',
  en: 'Who you are: A.\nYou handle: B.\nNot yours: C.\nHow you work: D.\nTone: E.\nAlways ask: F.',
}

describe('WP404 persona 拆段与拼回', () => {
  it('全部内置 persona（中文 + 生成的英文）都拆得开、拼回去逐字节相同', () => {
    let n = 0
    for (const { key, persona } of all()) {
      for (const lang of ['zh', 'en'] as const) {
        const text = personaTextIn(persona, lang)
        if (lang === 'en' && (typeof persona === 'string' || persona?.en === '')) continue
        const split = splitPersonaSections(text, lang)
        expect(split, `${key} ${lang}`).toBeDefined()
        if (split === undefined) continue
        expect(split.sections.map((s) => s.id)).toEqual(PERSONA_SECTION_IDS)
        expect(joinPersonaSections(split), `${key} ${lang}`).toBe(text)
        n += 1
      }
    }
    expect(n).toBeGreaterThan(100)
  })

  it('拆不开的：少一段、顺序乱、小标题不在行首', () => {
    expect(splitPersonaSections('你是谁：甲。\n你负责：乙。', 'zh')).toBeUndefined()
    const swapped = PACKAGED.zh.replace('口气：戊。\n必须出卡：己。', '必须出卡：己。\n口气：戊。')
    expect(splitPersonaSections(swapped, 'zh')).toBeUndefined()
    expect(splitPersonaSections(PACKAGED.zh.replace('\n你负责', ' 你负责'), 'zh')).toBeUndefined()
  })

  it('正文里提到别的小标题不算分段（只认行首 + 冒号）', () => {
    const text = PACKAGED.zh.replace('丁。', '丁，口气要稳，你负责到底。')
    const split = splitPersonaSections(text, 'zh')
    expect(split?.sections.find((s) => s.id === 'how')?.body).toBe('丁，口气要稳，你负责到底。')
    expect(split === undefined ? '' : joinPersonaSections(split)).toBe(text)
  })
})

describe('WP404 按段改写', () => {
  const mineZh = PACKAGED.zh.replace('口气：戊。', '口气：像老朋友。')

  it('只记改了的那几段', () => {
    expect(personaSectionDiff(PACKAGED, { zh: mineZh, en: '' })).toEqual({
      zh: { tone: '像老朋友。' },
    })
    expect(personaSectionDiff(PACKAGED, { zh: PACKAGED.zh, en: '' })).toEqual({})
  })

  it('叠出来的与整段替换时逐字节相同（中文改了、英文没给 → 英文留空 = 未翻译）', () => {
    const cases: PersonaText[] = [
      { zh: mineZh, en: '' },
      { zh: PACKAGED.zh, en: '' },
      { zh: mineZh, en: PACKAGED.en.replace('Tone: E.', 'Tone: like an old friend.') },
      { zh: PACKAGED.zh, en: PACKAGED.en.replace('Tone: E.', 'Tone: warm.') },
    ]
    for (const text of cases) {
      const sections = personaSectionDiff(PACKAGED, text)
      expect(sections).toBeDefined()
      expect(applyPersonaSectionOverride(PACKAGED, { text, sections })).toEqual(
        applyPersonaOverride(PACKAGED, text),
      )
    }
  })

  it('全部内置 persona：每一段各改一次，叠出来的都与整段替换相同', () => {
    for (const { key, persona } of all()) {
      if (persona === undefined || typeof persona === 'string') continue
      const split = splitPersonaSections(persona.zh, 'zh')
      if (split === undefined) throw new Error(key)
      for (const part of split.sections) {
        const zh = joinPersonaSections({
          ...split,
          sections: split.sections.map((s) => (s.id === part.id ? { ...s, body: '改过了。' } : s)),
        })
        const text = { zh, en: '' }
        const sections = personaSectionDiff(persona, text)
        expect(sections, key).toEqual({ zh: { [part.id]: '改过了。' } })
        expect(applyPersonaSectionOverride(persona, { text, sections })).toEqual(
          applyPersonaOverride(persona, text),
        )
      }
    }
  })

  it('拆不成六段的改写 → 不按段存（调用方照旧整段替换）', () => {
    expect(personaSectionDiff(PACKAGED, { zh: '一整段自己写的话。', en: '' })).toBeUndefined()
    expect(personaSectionDiff(PACKAGED, '老的纯字符串')).toBeUndefined()
    expect(personaSectionDiff(PACKAGED, { zh: `前言\n${mineZh}`, en: '' })).toBeUndefined()
    const whole = { text: { zh: '一整段自己写的话。', en: '' } }
    expect(applyPersonaSectionOverride(PACKAGED, whole)).toEqual(
      applyPersonaOverride(PACKAGED, whole.text),
    )
  })

  it('包里出了新版：没改过的段跟着新版走，改过的段留着用户的', () => {
    const text = { zh: mineZh, en: '' }
    const sections = personaSectionDiff(PACKAGED, text)
    const next = {
      zh: PACKAGED.zh
        .replace('怎么做：丁。', '怎么做：新版的做法。')
        .replace('口气：戊。', '口气：新版口气。'),
      en: PACKAGED.en,
    }
    const out = applyPersonaSectionOverride(next, { text, sections })
    expect(personaTextIn(out, 'zh')).toContain('怎么做：新版的做法。')
    expect(personaTextIn(out, 'zh')).toContain('口气：像老朋友。')
    expect(personaTextIn(out, 'zh')).not.toContain('新版口气')
    // 新版拆不开（写成一整段）→ 回落用户当时拼好的整段
    expect(
      applyPersonaSectionOverride({ zh: '新版改成一整段了。', en: '' }, { text, sections }),
    ).toEqual(applyPersonaOverride({ zh: '新版改成一整段了。', en: '' }, text))
  })

  it('面板：改了哪几段', () => {
    const text = { zh: mineZh, en: '' }
    const sections = personaSectionDiff(PACKAGED, text)
    expect(overriddenPersonaSections(sections)).toEqual(['tone'])
    const view = personaView({
      subject: { kind: 'role', id: 'x.y' },
      name: { zh: 'x', en: 'x' },
      packaged: PACKAGED,
      override: {
        workspace_id: 'ws',
        subject: { kind: 'role', id: 'x.y' },
        text,
        ...(sections === undefined ? {} : { sections }),
        updated_at: '2026-10-19T00:00:00.000Z',
        updated_by: 'p1',
      },
    })
    expect(view.overridden).toBe(true)
    expect(view.overridden_sections).toEqual(['tone'])
    expect(view.untranslated).toBe(true)
  })
})
