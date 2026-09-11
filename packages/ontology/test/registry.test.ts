/**
 * 47 J1 登记表的自洽性。
 *
 * 这一组断言管的是"生成器不许编"：登记表里出现的每一个对象、每一条链接、每一个动作，
 * 都必须在别的真源里找得到出处——对象来自 `ObjectType` 联合，数据域来自 `DataDomain`，
 * 变更种类来自 `ChangeKind`，风险级来自 15 的 `KIND_RISK`。
 * 有一格是凭空写的，这里就会红。
 */
import { readFileSync } from 'node:fs'
import type { ChangeKind, DataDomain, ObjectType } from '@agentsws/contracts'
import { KIND_RISK } from '@agentsws/core'
import { describe, expect, it } from 'vitest'
import { actionDef, linksOf, ONTOLOGY_JSON_PATH, objectDef, ontology } from '../src/index.js'

const registry = ontology()

/** 契约里的 `ObjectType` 联合（从源码读，不从登记表读——否则就是自己证明自己）。 */
function contractUnion(name: string): string[] {
  const src = readFileSync(new URL('../../contracts/src/common.ts', import.meta.url), 'utf8')
  const at = src.indexOf(`export type ${name} =`)
  expect(at, `契约里没有 ${name}`).toBeGreaterThan(-1)
  const body = src.slice(at, src.indexOf('\n\n', at))
  // 只认「行首一个 `|` 加一个字符串字面量」这种形状的成员行，注释里提到的名字不算
  return [...body.matchAll(/^\s*\|\s*'([a-z_]+)'/gm)].map((m) => m[1] as string)
}

describe('47 J1 登记表：每一格都有出处', () => {
  it('对象类型与契约的 ObjectType 联合逐个对得上', () => {
    const union = contractUnion('ObjectType')
    expect(registry.objects.map((o) => o.id).sort()).toEqual([...union].sort())
  })

  it('每个对象的数据域都是契约里的 DataDomain', () => {
    const domains = new Set<DataDomain>(contractUnion('DataDomain') as DataDomain[])
    for (const o of registry.objects) expect(domains.has(o.domain), o.id).toBe(true)
  })

  it('可读范围只可能是 own / assigned / workspace，且最宽的在前', () => {
    const width = { own: 0, assigned: 1, workspace: 2 }
    for (const o of registry.objects) {
      for (const r of o.read_ranges) expect(Object.keys(width)).toContain(r)
      const widths = o.read_ranges.map((r) => width[r])
      expect(
        [...widths].sort((a, b) => b - a),
        o.id,
      ).toEqual(widths)
    }
  })

  it('链接两端都是登记在册的对象；反向链接成对出现', () => {
    const ids = new Set(registry.objects.map((o) => o.id))
    for (const l of registry.links) {
      expect(ids.has(l.from), `${l.from}→${l.to}`).toBe(true)
      expect(ids.has(l.to), `${l.from}→${l.to}`).toBe(true)
    }
    for (const out of registry.links.filter((l) => l.direction === 'out')) {
      const back = registry.links.find(
        (l) => l.direction === 'in' && l.from === out.to && l.to === out.from,
      )
      expect(back, `${out.from}→${out.to} 没有反向链接`).toBeDefined()
    }
  })

  it('动作：对象在册、变更种类在册、风险级与 15 的 KIND_RISK 一致', () => {
    const ids = new Set(registry.objects.map((o) => o.id))
    for (const a of registry.actions) {
      expect(ids.has(a.object), a.id).toBe(true)
      if (a.change_kind === undefined) continue
      expect(Object.keys(KIND_RISK)).toContain(a.change_kind)
      expect(a.risk_class, a.id).toBe(KIND_RISK[a.change_kind as ChangeKind])
    }
  })

  it('写动作一律要人批（15 §5：写只经账本）', () => {
    for (const a of registry.actions) {
      expect(a.requires_approval, a.id).toBe(a.access === 'write')
    }
  })

  it('id 不重复', () => {
    const objects = registry.objects.map((o) => o.id)
    expect(new Set(objects).size).toBe(objects.length)
    const actions = registry.actions.map((a) => a.id)
    expect(new Set(actions).size).toBe(actions.length)
  })

  it('产出工具只有两个（17 §1），且都挂在职责动作上', () => {
    const tools = registry.actions.flatMap((a) => (a.tool === undefined ? [] : [a]))
    expect(tools.map((a) => a.tool).sort()).toEqual(['draft_reply', 'stage_refund'])
    for (const a of tools) expect(a.source).toBe('role')
  })

  it('订单：真源是平台、按缓存周期算新鲜度、查得到的口在册', () => {
    const order = objectDef('order' as ObjectType)
    expect(order?.source_of_truth).toBe('platform_api')
    expect(order?.freshness).toMatch(/^cached:\d+$/)
    expect(order?.read_via).toContain('shopify_admin.get_order')
    expect(linksOf('order' as ObjectType).length).toBeGreaterThan(0)
  })

  it('事实卡：真源是人、新鲜度是 authored（19 §1 知识层不存状态）', () => {
    const card = objectDef('fact_card' as ObjectType)
    expect(card?.source_of_truth).toBe('human')
    expect(card?.freshness).toBe('authored')
  })

  it('退款动作指向订单，带 refund 这条变更种类', () => {
    const stage = actionDef('stage_refund')
    expect(stage?.object).toBe('order')
    expect(stage?.change_kind).toBe('refund')
  })

  it('登记表是生成物：文件里带着它从哪几份输入生成的', () => {
    expect(registry.version).toBe(1)
    expect(registry.generated_from).toContain('packages/contracts/src/common.ts')
    expect(registry.generated_from).toContain('packages/connect-adapter/action-side-effects.yml')
    expect(registry.source_digest).toMatch(/^[0-9a-f]{32}$/)
    expect(readFileSync(ONTOLOGY_JSON_PATH, 'utf8').endsWith('\n')).toBe(true)
  })
})
