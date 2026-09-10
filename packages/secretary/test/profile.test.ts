/** Profile 与公开级别（41 §1.3 那张表就是这份用例的验收表）。 */
import { describe, expect, it } from 'vitest'
import {
  applyProfilePatch,
  clampLevel,
  DEFAULT_DISCLOSURE,
  dedupeSkills,
  defaultProfile,
  type PersonProfile,
  relationOf,
  visibleProfile,
  visibleTo,
} from '../src/index.js'
import { position, T0, WS } from './helpers.js'

const base = (): PersonProfile => ({
  ...defaultProfile({ workspace_id: WS, person_id: 'p_li', at: T0 }),
  name: '李默',
  positions: [position('a1', 'dtc.ops', '独立站运营', [{ kind: 'store', id: 'store_main' }])],
  ranges: [{ kind: 'store', id: 'store_main' }],
  skills: [{ name: '退款政策', source: 'skill' }],
})

describe('默认公开级别 = 41 §1.3 那一列', () => {
  it('岗位 / 范围 / 进行中 / 忙闲 / 擅长默认同事可见，日程明细默认仅本人', () => {
    const p = defaultProfile({ workspace_id: WS, person_id: 'p_li', at: T0 })
    expect(p.disclosure).toEqual(DEFAULT_DISCLOSURE)
    expect(p.disclosure.positions).toBe('colleagues')
    expect(p.disclosure.in_progress).toBe('colleagues')
    expect(p.disclosure.availability).toBe('colleagues')
    expect(p.disclosure.skills).toBe('colleagues')
    expect(p.disclosure.agenda_detail).toBe('self')
  })

  it('日程明细最高只能到"同事可见"（那一行没有"全工作区"这一格）', () => {
    expect(clampLevel('agenda_detail', 'workspace')).toBe('colleagues')
    expect(clampLevel('positions', 'workspace')).toBe('workspace')
    const p = applyProfilePatch(
      defaultProfile({ workspace_id: WS, person_id: 'p_li', at: T0 }),
      { disclosure: { agenda_detail: 'workspace' } },
      T0,
    )
    expect(p.disclosure.agenda_detail).toBe('colleagues')
  })
})

describe('谁看得见', () => {
  it('本人什么都看得见；同事看得见 colleagues 以上；外人只看得见 workspace', () => {
    expect(visibleTo('self', 'self')).toBe(true)
    expect(visibleTo('self', 'colleague')).toBe(false)
    expect(visibleTo('colleagues', 'colleague')).toBe(true)
    expect(visibleTo('colleagues', 'outsider')).toBe(false)
    expect(visibleTo('workspace', 'outsider')).toBe(true)
  })

  it('同一个工作区的人是同事，别的工作区是外人', () => {
    expect(relationOf({ viewer: 'a', subject: 'a', same_workspace: true })).toBe('self')
    expect(relationOf({ viewer: 'a', subject: 'b', same_workspace: true })).toBe('colleague')
    expect(relationOf({ viewer: 'a', subject: 'b', same_workspace: false })).toBe('outsider')
  })
})

describe('过滤出问方那一份', () => {
  it('同事拿到岗位与擅长，拿不到公开级别本身', () => {
    const v = visibleProfile(base(), 'colleague')
    expect(v.positions?.[0]?.role_name).toBe('独立站运营')
    expect(v.skills?.[0]?.name).toBe('退款政策')
    // 「我把什么藏起来了」本身也是隐私
    expect(v.disclosure).toBeUndefined()
    expect(v.hidden_fields).toContain('agenda_detail')
  })

  it('本人拿得到公开级别（设置页要照着它画）', () => {
    const v = visibleProfile(base(), 'self')
    expect(v.disclosure?.agenda_detail).toBe('self')
    expect(v.hidden_fields).toEqual([])
  })

  it('把忙闲设成仅本人之后，同事那一份里就没有 availability 了', () => {
    const p = base()
    p.disclosure = { ...p.disclosure, availability: 'self' }
    const v = visibleProfile(p, 'colleague')
    expect(v.availability).toBeUndefined()
    expect(v.hidden_fields).toContain('availability')
  })

  it('本人手动藏掉的擅长不出现在别人那一份里', () => {
    const p = base()
    p.skills = [
      { name: '退款政策', source: 'skill' },
      { name: '德语', source: 'memory', hidden: true },
    ]
    expect(visibleProfile(p, 'colleague').skills?.map((s) => s.name)).toEqual(['退款政策'])
  })
})

describe('补丁只覆盖给了的字段', () => {
  it('只改可用时段不会把公开级别重置掉', () => {
    const prev = applyProfilePatch(
      defaultProfile({ workspace_id: WS, person_id: 'p_li', at: T0 }),
      { disclosure: { in_progress: 'self' } },
      T0,
    )
    const next = applyProfilePatch(
      prev,
      { availability: { rules: [{ days: [1], from: '10:00', to: '12:00' }] } },
      '2026-09-08T01:00:00.000Z',
    )
    expect(next.disclosure.in_progress).toBe('self')
    expect(next.availability.rules).toEqual([{ days: [1], from: '10:00', to: '12:00' }])
    // 没给的那一格保持原样
    expect(next.availability.default_minutes).toBe(prev.availability.default_minutes)
    expect(next.updated_at).toBe('2026-09-08T01:00:00.000Z')
  })

  it('同名擅长只留一条，本人写的赢过算出来的', () => {
    const merged = dedupeSkills([
      { name: '退款政策', source: 'memory' },
      { name: '退款政策', source: 'self' },
      { name: '德语', source: 'skill' },
    ])
    expect(merged).toHaveLength(2)
    expect(merged.find((s) => s.name === '退款政策')?.source).toBe('self')
  })
})
