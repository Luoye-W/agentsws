/**
 * WP120（69）：角色定位的纯逻辑——取语言、六段骨架、叠覆盖、装配成段。
 *
 * 这一组钉的是**机制**；「每一条职责的定位都说清了不负责什么」那一半在
 * `persona-crosswalk.test.ts` 里逐条钉。
 */
import { describe, expect, it } from 'vitest'
import {
  applyPersonaOverride,
  checkAllPersonas,
  checkPersona,
  HOUSE_RULES_ORDER,
  houseRulesSection,
  loadBundledPositions,
  loadBundledRoles,
  MAX_PERSONA_CHARS,
  PERSONA_ORDER,
  PERSONA_SECTIONS_EN,
  PERSONA_SECTIONS_ZH,
  personaIsEmpty,
  personaKey,
  personaSections,
  personaTextIn,
  renderBrandContext,
} from '../src/index.js'

/** 一段过得了体检的中文 persona（六段齐全）。 */
const OK_ZH = [
  '你是谁：测试用的一条职责。',
  '你负责：把这一段读完。',
  '你不负责：别的事→别的岗位。',
  '怎么做：先看再动。',
  '口气：直说。',
  '必须出卡：任何对外的东西。',
].join('\n')

const OK_EN = [
  'Who you are: a duty used in tests.',
  'You handle: reading this through.',
  'Not yours: anything else → another position.',
  'How you work: look first, then act.',
  'Tone: plain.',
  'Always ask: anything that goes outward.',
].join('\n')

describe('取语言（69 §1）', () => {
  it('老的纯字符串写法：两种语言都回它（那是"只有一份"，不是"中文的"）', () => {
    expect(personaTextIn('只有一份', 'zh')).toBe('只有一份')
    expect(personaTextIn('只有一份', 'en')).toBe('只有一份')
  })

  it('`{ zh, en }`：要哪份给哪份', () => {
    expect(personaTextIn({ zh: '中', en: 'EN' }, 'zh')).toBe('中')
    expect(personaTextIn({ zh: '中', en: 'EN' }, 'en')).toBe('EN')
  })

  it('要的那份空了就回落另一份——空白的 persona 比语言不对糟得多', () => {
    expect(personaTextIn({ zh: '中', en: '  ' }, 'en')).toBe('中')
    expect(personaTextIn({ zh: '', en: 'EN' }, 'zh')).toBe('EN')
  })

  it('两份都空 = 空', () => {
    expect(personaIsEmpty({ zh: '', en: ' ' })).toBe(true)
    expect(personaIsEmpty(undefined)).toBe(true)
    expect(personaIsEmpty('有')).toBe(false)
  })
})

describe('六段骨架（69 §2）', () => {
  it('六段都在就过', () => {
    expect(checkPersona({ zh: OK_ZH, en: OK_EN })).toBeUndefined()
  })

  it('空的直接失败（这一条就是 gen-ontology --check 那一刀的判据）', () => {
    expect(checkPersona(undefined)).toContain('空')
    expect(checkPersona({ zh: '', en: '' })).toContain('空')
  })

  it('少了「你不负责」就失败——那是防串岗的那一段，不许省', () => {
    const missing = OK_ZH.split('\n')
      .filter((l) => !l.startsWith('你不负责'))
      .join('\n')
    expect(checkPersona({ zh: missing, en: OK_EN })).toContain('你不负责')
  })

  it('英文那份少一段也失败（两份说的要是同一件事）', () => {
    const missing = OK_EN.split('\n')
      .filter((l) => !l.startsWith('Not yours'))
      .join('\n')
    expect(checkPersona({ zh: OK_ZH, en: missing })).toContain('Not yours')
  })

  it('超长失败；中英各一个上限（英文同义表达天然长一倍）', () => {
    const long = `${OK_ZH}\n${'长'.repeat(MAX_PERSONA_CHARS.zh)}`
    expect(checkPersona({ zh: long, en: OK_EN })).toContain('上限')
    expect(MAX_PERSONA_CHARS.en).toBeGreaterThan(MAX_PERSONA_CHARS.zh)
  })

  it('六个小标题中英一一对应', () => {
    expect(PERSONA_SECTIONS_ZH).toHaveLength(PERSONA_SECTIONS_EN.length)
  })
})

describe('全部职责与全部岗位一条都不许空（69 §2）', () => {
  it('四十多条职责 + 十个岗位，逐条过体检', () => {
    const problems = checkAllPersonas({
      roles: loadBundledRoles(),
      positions: loadBundledPositions(),
    })
    expect(problems.map((p) => `${p.subject.kind}:${p.subject.id} ${p.message}`)).toEqual([])
  })

  it('数量对得上（少写一条不会悄悄溜过去）', () => {
    expect(loadBundledRoles().length).toBeGreaterThanOrEqual(41)
    expect(loadBundledPositions().length).toBeGreaterThanOrEqual(9)
  })
})

describe('公司层覆盖（69 §4）', () => {
  it('覆盖里空着的那一边回落包里的原文', () => {
    const merged = applyPersonaOverride({ zh: '原中', en: 'orig-en' }, { zh: '新中', en: '' })
    expect(personaTextIn(merged, 'zh')).toBe('新中')
    expect(personaTextIn(merged, 'en')).toBe('orig-en')
  })

  it('没有覆盖就是原文（包里的那一份一个字不动）', () => {
    expect(applyPersonaOverride('原文', undefined)).toBe('原文')
  })

  it('查表键把两层分得开', () => {
    expect(personaKey({ kind: 'position', id: 'web-ops' })).toBe('position:web-ops')
    expect(personaKey({ kind: 'role', id: 'kol.youtube' })).toBe('role:kol.youtube')
    expect(personaKey({ kind: 'position', id: 'x' })).not.toBe(
      personaKey({ kind: 'role', id: 'x' }),
    )
  })
})

describe('装配成段（69 §3）', () => {
  it('品牌 → 岗位 → 职责，顺序是这个', () => {
    const sections = personaSections({
      brand: { brand_name: '甲品牌' },
      position: { id: 'kol-marketing', name: '红人营销', persona: OK_ZH },
      role: { id: 'kol.youtube', name: 'YouTube 红人', persona: OK_ZH },
    })
    expect(sections.map((s) => s.id)).toEqual(['brand', 'position', 'role'])
    expect(sections.map((s) => s.order)).toEqual([
      PERSONA_ORDER.brand,
      PERSONA_ORDER.position,
      PERSONA_ORDER.role,
    ])
  })

  it('空的那一节不出现——系统提示里放一个空标题只会把模型带偏', () => {
    const sections = personaSections({
      position: { id: 'p', name: 'P', persona: '   ' },
      role: { id: 'r', persona: OK_ZH },
    })
    expect(sections.map((s) => s.id)).toEqual(['role'])
  })

  it('反查不出唯一岗位时整段不出（54 §3「不猜一个」）', () => {
    const sections = personaSections({ role: { id: 'r', persona: OK_ZH } })
    expect(sections.some((s) => s.id === 'position')).toBe(false)
  })

  it('英文界面拿英文那份', () => {
    const [section] = personaSections({
      lang: 'en',
      role: { id: 'r', persona: { zh: OK_ZH, en: OK_EN } },
    })
    expect(section?.text).toBe(OK_EN)
  })
})

describe('品牌上下文：取不到就不写那一句（69 §5「别编」）', () => {
  it('一格都没有 → 空串 → 调用方不出这一节', () => {
    expect(renderBrandContext(undefined)).toBe('')
    expect(renderBrandContext({})).toBe('')
    expect(personaSections({ brand: {}, role: { id: 'r', persona: OK_ZH } })).toHaveLength(1)
  })

  it('只有品牌名 → 只出品牌名那一行，不替它编一个定位', () => {
    const text = renderBrandContext({ brand_name: '甲品牌' })
    expect(text).toBe('品牌：甲品牌')
    expect(text).not.toContain('定位')
  })

  it('WP122 的「视觉气质」是同一个槽位：填上就多一行，别处一行不用改', () => {
    const text = renderBrandContext({ brand_name: '甲', visual_tone: '克制的暖色' })
    expect(text.split('\n')).toEqual(['品牌：甲', '视觉气质：克制的暖色'])
  })

  it('口吻样例只是语气参考，明写着别照抄', () => {
    const text = renderBrandContext({ brand_name: '甲', tone_samples: ['我们不催单。'] })
    expect(text).toContain('别照抄')
    expect(text).toContain('- 我们不催单。')
  })
})

describe('WP153：所有职责的提示词公共段', () => {
  it('一句「不提工具名、函数名、内部 id」，排在职责（20）后面、技能（40）前面', () => {
    const zh = houseRulesSection('zh')
    expect(zh.text).toContain('不提工具名、函数名、内部 id')
    expect(zh.order).toBe(HOUSE_RULES_ORDER)
    expect(HOUSE_RULES_ORDER).toBeGreaterThan(PERSONA_ORDER.role)
    expect(HOUSE_RULES_ORDER).toBeLessThan(40)
    expect(houseRulesSection('en').text).toContain('never mention tool names')
  })
})
