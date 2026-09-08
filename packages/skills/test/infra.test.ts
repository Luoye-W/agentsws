import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  createFileSidecarStore,
  createMemorySidecarStore,
  createSkills,
  createUlidFactory,
  mergeKnown,
  renderSkill,
  SkillsError,
  sidecarToKnown,
} from '../src/index.js'
import { CUSTOMER_CARE_V1, FakeClock, seededRandom } from './helpers.js'

describe('ULID', () => {
  it('时钟冻结时单调递增且不重复', () => {
    const next = createUlidFactory(new FakeClock(), seededRandom(7))
    const ids = Array.from({ length: 200 }, () => next())
    expect(new Set(ids).size).toBe(200)
    const sorted = [...ids].sort()
    expect(sorted).toEqual(ids)
  })

  it('进位到高位也不重复', () => {
    const next = createUlidFactory(new FakeClock(), () => 0.999)
    const ids = Array.from({ length: 40 }, () => next())
    expect(new Set(ids).size).toBe(40)
  })

  it('时钟推进时前缀跟着变', () => {
    const clock = new FakeClock()
    const next = createUlidFactory(clock, seededRandom(1))
    const a = next()
    clock.advance(60_000)
    expect(next().slice(0, 10)).not.toBe(a.slice(0, 10))
  })

  it('非法时钟 → invalid_input', () => {
    const bad: Clock = { now: () => 'not-a-date' }
    expect(() => createUlidFactory(bad, seededRandom())()).toThrow(SkillsError)
  })
})

describe('sidecar', () => {
  it('内存 store 读写隔离副本', () => {
    const store = createMemorySidecarStore()
    expect(store.read('x')).toBeUndefined()
    store.write({ skill: 'x', sections: [{ id: '1', heading: 'a', body_hash: 'h' }] })
    const read = store.read('x')
    const entry = read?.sections[0]
    if (entry === undefined) throw new Error('unreachable')
    entry.heading = '改了'
    expect(store.read('x')?.sections[0]?.heading).toBe('a')
  })

  it('文件名非法字符被替换，空名报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-sidecar-'))
    const store = createFileSidecarStore(dir)
    store.write({ skill: 'a/b:c', sections: [] })
    expect(store.read('a/b:c')?.sections).toEqual([])
    expect(() => store.write({ skill: '..', sections: [] })).toThrow(/非法 skill 名/)
  })

  it('损坏的 sidecar 文件 → invalid_input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-sidecar-'))
    writeFileSync(join(dir, 'broken.sections.json'), '{"skill":1}', 'utf8')
    expect(() => createFileSidecarStore(dir).read('broken')).toThrow(/格式非法/)
  })

  it('sidecarToKnown / mergeKnown', () => {
    expect(sidecarToKnown(undefined)).toEqual([])
    const merged = mergeKnown(
      [{ id: '1', heading: 'a', body_hash: 'h1' }],
      [
        { id: '1', heading: '旧', body_hash: 'x' },
        { id: '2', heading: 'b', body_hash: 'h2' },
      ],
    )
    expect(merged.map((k) => [k.id, k.heading])).toEqual([
      ['1', 'a'],
      ['2', 'b'],
    ])
  })
})

describe('渲染与错误', () => {
  it('前言段（没有 ## 标题）原样渲染', () => {
    const { registry } = createSkills({ clock: new FakeClock(), random: seededRandom() })
    const doc = registry.parseDocument('---\nname: t\n---\n\n前言一句话。\n\n## 一\n\nx\n')
    expect(doc.sections[0]?.heading).toBe('')
    const md = renderSkill(doc.frontmatter, doc.sections)
    expect(md).toBe('---\nname: t\n---\n\n前言一句话。\n\n## 一\n\nx\n')
  })

  it('SkillsError 带 code 与 details', () => {
    const err = new SkillsError('conflict', 'boom', { a: 1 })
    expect(err.code).toBe('conflict')
    expect(err.details).toEqual({ a: 1 })
    expect(err.name).toBe('SkillsError')
  })

  it('createSkills 默认用内存 sidecar', async () => {
    const skills = createSkills({ clock: new FakeClock(), random: seededRandom() })
    await skills.registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1,
      tier: 'package',
      owner: 'package',
      version: '1.0',
    })
    expect(skills.sidecar.read('customer-care')?.sections).toHaveLength(4)
    expect(skills.nextId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})
