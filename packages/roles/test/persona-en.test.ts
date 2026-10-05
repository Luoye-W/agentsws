/**
 * WP226（69 §1.1）：英文 persona 由中文生成——哈希对账、读进来时补英文、产物本身合格。
 *
 * 钉三件事：
 * 1. **机制**：中文改了、英文没重出 → 判「过期」，读进来时**不用**那份旧英文；
 * 2. **产物**：仓库里签着的那份与包里每一段中文都对得上，而且一个汉字都没有
 *    （docs/91 §3.3 那 14 条混中文的就是这一刀要防的）；
 * 3. **yml 里不再手写英文**：真源只有中文。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_POSITIONS_DIR,
  BUNDLED_ROLES_DIR,
  checkPersonaEn,
  hasChineseText,
  loadBundledPositions,
  loadBundledRole,
  loadBundledRoles,
  loadGeneratedPersonaEn,
  PERSONA_EN_FILE,
  parseRole,
  personaTextIn,
  personaUntranslated,
  personaZhHash,
  withGeneratedEn,
} from '../src/index.js'

const ZH =
  '你是谁：甲。\n你负责：乙。\n你不负责：丙→客服。\n怎么做：丁。\n口气：戊。\n必须出卡：己。'
const EN =
  'Who you are: A.\nYou handle: B.\nNot yours: C → Customer Care.\nHow you work: D.\nTone: E.\nAlways ask: F.'

describe('哈希', () => {
  it('首尾空白与换行风格不算改动（yml 的 `|` 块末尾多一个换行不该让英文过期）', () => {
    expect(personaZhHash(`${ZH}\n`)).toBe(personaZhHash(ZH))
    expect(personaZhHash(ZH.replace(/\n/g, '\r\n'))).toBe(personaZhHash(ZH))
    expect(personaZhHash(`${ZH}多一个字`)).not.toBe(personaZhHash(ZH))
  })
})

describe('读进来时补英文', () => {
  const subject = { kind: 'role', id: 'x.y' } as const
  const generated = new Map([['role:x.y', { zh_hash: personaZhHash(ZH), en: EN }]])

  it('哈希对得上 → 用生成的英文', () => {
    expect(personaTextIn(withGeneratedEn(subject, { zh: ZH, en: '' }, generated), 'en')).toBe(EN)
  })

  it('中文改过了（过期）→ 不用那份旧英文：英文空着，取英文回落中文、标「未翻译」', () => {
    const changed = `${ZH}多一句`
    const persona = withGeneratedEn(subject, { zh: changed, en: '' }, generated)
    expect(personaTextIn(persona, 'en')).toBe(changed)
    expect(personaUntranslated(persona)).toBe(true)
  })

  it('产物里没有、yml 里还留着手写英文（合并期间的老写法）→ 用手写的', () => {
    expect(
      personaTextIn(withGeneratedEn(subject, { zh: `${ZH}改`, en: EN }, new Map()), 'en'),
    ).toBe(EN)
  })

  it('外面读进来的职责 yml 不补（产物只管包里自带的那几条）', () => {
    const yml = readFileSync(join(BUNDLED_ROLES_DIR, 'dtc/support.yml'), 'utf8')
    const role = parseRole(yml, 'external')
    expect(personaTextIn(role.persona, 'en')).toBe(personaTextIn(role.persona, 'zh'))
    expect(personaTextIn(loadBundledRole('dtc.support').persona, 'en')).toContain('Who you are')
  })

  it('产物文件坏了 / 没有 → 空表，不让进程起不来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp226-persona-en-'))
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ not json', 'utf8')
    expect(loadGeneratedPersonaEn(bad).size).toBe(0)
    expect(loadGeneratedPersonaEn(join(dir, 'missing.json')).size).toBe(0)
  })
})

describe('对账（`gen-persona-en --check` 的那一刀）', () => {
  const subjects = [{ subject: { kind: 'role', id: 'x.y' } as const, persona: { zh: ZH, en: '' } }]

  it('缺 / 过期 / 不合格 / 多出来，四种各报一条', () => {
    expect(checkPersonaEn({ subjects, generated: new Map() }).map((p) => p.kind)).toEqual([
      'missing',
    ])
    const stale = new Map([['role:x.y', { zh_hash: personaZhHash('旧的'), en: EN }]])
    expect(checkPersonaEn({ subjects, generated: stale }).map((p) => p.kind)).toEqual(['stale'])
    const mixed = new Map([
      ['role:x.y', { zh_hash: personaZhHash(ZH), en: EN.replace('A.', '广告素材') }],
    ])
    expect(checkPersonaEn({ subjects, generated: mixed }).map((p) => p.kind)).toEqual(['invalid'])
    const orphan = new Map([
      ['role:x.y', { zh_hash: personaZhHash(ZH), en: EN }],
      ['role:gone', { zh_hash: personaZhHash(ZH), en: EN }],
    ])
    expect(checkPersonaEn({ subjects, generated: orphan }).map((p) => p.key)).toEqual(['role:gone'])
  })
})

describe('仓库里签着的那份产物', () => {
  const subjects = [
    ...loadBundledPositions().map((p) => ({
      subject: { kind: 'position', id: p.id } as const,
      persona: p.persona,
    })),
    ...loadBundledRoles().map((r) => ({
      subject: { kind: 'role', id: r.id } as const,
      persona: r.persona,
    })),
  ]

  it('与包里每一段中文都对得上（中文改了忘了重出会红在这里，同 --check --strict）', () => {
    const problems = checkPersonaEn({ subjects, generated: loadGeneratedPersonaEn() })
    expect(problems.map((p) => `${p.key} ${p.message}`)).toEqual([])
  })

  it('每一条英文都没有汉字、六个小标题都在（docs/91 §3.3 那 14 条就是这一刀）', () => {
    for (const { subject, persona } of subjects) {
      const en = personaTextIn(persona, 'en')
      expect(hasChineseText(en), `${subject.kind}:${subject.id}`).toBe(false)
      expect(en, `${subject.kind}:${subject.id}`).toContain('Not yours')
    }
  })

  it('yml 里不再手写英文：真源只有中文', () => {
    const files = [
      ...loadBundledPositions().map((p) => join(BUNDLED_POSITIONS_DIR, `${p.id}.yml`)),
      ...loadBundledRoles().map((r) => `${join(BUNDLED_ROLES_DIR, ...r.id.split('.'))}.yml`),
    ]
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/^ {2}en: \|/m)
  })

  it('产物文件就在包里（随包走）', () => {
    expect(PERSONA_EN_FILE.endsWith('persona-en.generated.json')).toBe(true)
    expect(loadGeneratedPersonaEn().size).toBeGreaterThanOrEqual(60)
  })
})
