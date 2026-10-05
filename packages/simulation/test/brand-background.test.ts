/**
 * WP215（52 §4）：每个品牌一套后台、共用一个调度循环——眼前切在哪个品牌都不影响别的品牌的后台。
 *
 * 场景那一条（`org/brand-b-patrols-while-viewing-a`）保证它在三个运行时下都跑得通；
 * 这里钉三件事：新 DSL 的解析、世界里的行为本身（数字）、以及断言在"串品牌"时真的会红。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Evidence } from '../src/index.js'
import {
  checkExpectations,
  loadPack,
  loadScenario,
  parseScenario,
  runScenario,
  ScenarioSchemaError,
} from '../src/index.js'
import { createWorld, type World } from '../src/world.js'
import { REPO_ROOT } from './helpers.js'

const PACK_15 = join(REPO_ROOT, 'packs', 'dtc-15p')
const A = 'ws_brand_a'
const B = 'ws_brand_b'

const HEAD = `
id: t/brand-bg
version: 1
dataset: { pack: dtc-15p, seed: 42 }
stand_ins: { provider: mock_open_connector, model: stub, clock: virtual, delivery: inbox }
clock: { start: '2026-09-15T09:00:00+08:00' }
events:
`

describe('WP215 DSL：org.brand_view / brand_background / brand_halt / brand_background_check', () => {
  it('四条新事件与 expected.brand_background 解析得出来', () => {
    const s = parseScenario(
      `${HEAD}  - at: '+0m'
    org.brand_background: { brand: ${B}, who: p_li, every: 15m, halted: true }
  - at: '+1m'
    org.brand_view: { brand: ${A}, who: p_li }
  - at: '+2m'
    org.brand_halt: { brand: ${B}, on: false }
  - at: '+3m'
    org.brand_background_check: { brand: ${B}, who: p_li }
expected:
  brand_background: { brand: ${B}, viewing: ${A}, min_patrols: 3, halt_isolated: true }
invariants: [prompt_replayable]
`,
      't.yml',
    )
    expect(s.events.map((e) => e.type)).toEqual([
      'org.brand_background',
      'org.brand_view',
      'org.brand_halt',
      'org.brand_background_check',
    ])
    expect(s.events[0]).toMatchObject({
      brand_background: { brand: B, who: 'p_li', every: '15m', halted: true },
    })
    expect(s.events[2]).toMatchObject({ brand_halt: { brand: B, on: false } })
    expect(s.expected.brand_background).toEqual({
      brand: B,
      viewing: A,
      min_patrols: 3,
      halt_isolated: true,
    })
  })

  it('写错的当场顶回来', () => {
    const ev = (body: string) => () =>
      parseScenario(`${HEAD}  - at: '+0m'\n    ${body}\ninvariants: [prompt_replayable]\n`, 't.yml')
    expect(ev(`org.brand_background: { brand: ${B}, who: p_li, every: 0m }`)).toThrow(
      ScenarioSchemaError,
    )
    expect(ev(`org.brand_background: { brand: ${B}, who: p_li, view: ${A} }`)).toThrow(
      ScenarioSchemaError,
    )
    expect(ev(`org.brand_halt: { brand: ${B}, on: yes please }`)).toThrow(ScenarioSchemaError)
    expect(ev(`org.brand_view: { brand: ${A} }`)).toThrow(ScenarioSchemaError)
    const exp = (body: string) => () =>
      parseScenario(
        `${HEAD}  - at: '+0m'\n    clock.advance: {}\nexpected:\n  brand_background: ${body}\ninvariants: [prompt_replayable]\n`,
        't.yml',
      )
    expect(exp(`{ brand: ${B}, viewing: ${B}, min_patrols: 1 }`)).toThrow(ScenarioSchemaError)
    expect(exp(`{ brand: ${B}, viewing: ${A}, min_patrols: 0 }`)).toThrow(ScenarioSchemaError)
    expect(exp(`{ brand: ${B}, viewing: ${A} }`)).toThrow(ScenarioSchemaError)
  })
})

/** 合成时钟往前推，每 5 分钟驱动一次品牌后台（与 runner 的一拍同步长）。 */
async function advance(world: World, minutes: number): Promise<void> {
  const until = new Date(world.clock.nowMs() + minutes * 60_000).toISOString()
  await world.clock.runUntil(until, 5 * 60_000, async (now) => {
    await world.brandBackground?.scheduler.runDue(now)
  })
}

describe('WP215 世界：视图停在甲，乙的后台照跑、结果只进乙', () => {
  it('切视图不影响谁跑；卡与事件都记任务自己的品牌；急停只停乙', async () => {
    const world = await createWorld({
      pack: loadPack(PACK_15),
      seed: 42,
      start: '2026-09-15T01:00:00.000Z',
    })
    try {
      await world.org.brand({ id: A, name: '甲', who: 'p_li', role: 'dtc.store' })
      await world.org.brand({ id: B, name: '乙', who: 'p_li', role: 'dtc.support' })
      // 没装之前世界里没有这个调度器（其余场景零漂移靠的就是这一条）
      expect(world.brandBackground).toBeUndefined()
      const bg = world.startBrandBackground()
      await bg.add({ brand: A, who: 'p_li', every_ms: 30 * 60_000 })
      await bg.add({ brand: B, who: 'p_li', every_ms: 15 * 60_000 })
      world.viewBrand(A, 'p_li')

      await advance(world, 60)
      const b1 = await bg.check(B, 'p_li')
      const a1 = await bg.check(A, 'p_li')
      expect(b1).toMatchObject({ state: 'running', scheduled: 1, patrols: 4, own_cards: 4 })
      expect(b1.foreign_cards).toEqual({})
      expect(a1).toMatchObject({ patrols: 2, own_cards: 2 })
      expect(a1.foreign_cards).toEqual({})

      // 巡检事件记的是乙自己的工作区，跑的时候眼前是甲
      const patrolsOfB = world.events.filter(
        (e) => e.type === 'simulation.brand_patrol' && e.workspace_id === B,
      )
      expect(patrolsOfB).toHaveLength(4)
      for (const e of patrolsOfB) expect(e.payload).toMatchObject({ brand: B, viewing: A })
      // 调度器自己的触发事件也记任务自己的品牌
      expect(
        world.events.filter((e) => e.type.startsWith('schedule.') && e.workspace_id === B).length,
      ).toBeGreaterThan(0)

      // 乙急停一个钟头：乙一次不跑，甲照跑
      bg.halt(B, true)
      await advance(world, 60)
      const b2 = await bg.check(B, 'p_li')
      const a2 = await bg.check(A, 'p_li')
      expect(b2).toMatchObject({ state: 'halted', patrols: 4, own_cards: 4 })
      expect(a2.patrols).toBe(4)

      // 放开：错过的那一段补一次，之后照常
      bg.halt(B, false)
      await advance(world, 5)
      expect((await bg.check(B, 'p_li')).patrols).toBe(5)
    } finally {
      await world.close()
    }
  })

  it('没装配的品牌到点就失败，绝不借别的品牌那一份', async () => {
    const world = await createWorld({
      pack: loadPack(PACK_15),
      seed: 42,
      start: '2026-09-15T01:00:00.000Z',
    })
    try {
      await world.org.brand({ id: A, name: '甲', who: 'p_li', role: 'dtc.store' })
      const bg = world.startBrandBackground()
      await bg.add({ brand: A, who: 'p_li', every_ms: 15 * 60_000 })
      // 丙品牌的任务直接塞进共享调度器，但丙没登记处理器
      await bg.scheduler.schedule({
        workspace_id: 'ws_brand_c',
        owner: 'p_li',
        role_id: 'dtc.store',
        assignment_id: 'asg_c',
        created_by: 'user',
        misfire_policy: 'run_once_now',
        handler: 'brand.patrol',
        trigger: { kind: 'interval', every_ms: 15 * 60_000 },
      })
      await advance(world, 15)
      const [c] = bg.scheduler.list({ workspace_id: 'ws_brand_c' })
      expect(c?.last_error).toContain('ws_brand_c')
      // 甲照常一张，丙那一次没有借甲的处理器往甲的队列里写
      const a = await bg.check(A, 'p_li')
      expect(a).toMatchObject({ patrols: 1, own_cards: 1 })
      expect(a.foreign_cards).toEqual({})
    } finally {
      await world.close()
    }
  })
})

describe('WP215 场景与断言', () => {
  const scenario = loadScenario(
    join(PACK_15, 'scenarios', 'org', 'brand-b-patrols-while-viewing-a.yml'),
  )

  it('场景跑通；把乙的巡检记到甲名下（串品牌）时 brand_background 变红', async () => {
    let evidence: Evidence | undefined
    const report = await runScenario(scenario, {
      pack: loadPack(PACK_15),
      captureEvidence: (e) => {
        evidence = e
      },
    })
    expect(report.passed).toBe(true)
    if (evidence === undefined) throw new Error('没有拿到证据')
    const want = { brand_background: scenario.expected.brand_background } as const
    const ok = checkExpectations(want, evidence, {} as never)
    expect(ok).toEqual([expect.objectContaining({ key: 'brand_background', ok: true })])

    // 串品牌：乙的巡检事件写进了"眼前品牌"甲
    const leaked: Evidence = {
      ...evidence,
      events: evidence.events.map((e) =>
        e.type === 'simulation.brand_patrol' && e.workspace_id === B
          ? { ...e, workspace_id: A }
          : e,
      ),
    }
    const red = checkExpectations(want, leaked, {} as never)
    expect(red[0]?.ok).toBe(false)

    // 急停串品牌：乙急停那一段甲也没跑
    const halts = evidence.events.flatMap((e, i) =>
      e.type === 'simulation.brand_halted' ? [i] : [],
    )
    const [on, off] = [halts[0] ?? -1, halts[halts.length - 1] ?? -1]
    const haltAll: Evidence = {
      ...evidence,
      events: evidence.events.filter(
        (e, i) => e.type !== 'simulation.brand_patrol' || e.workspace_id !== A || i < on || i > off,
      ),
    }
    expect(checkExpectations(want, haltAll, {} as never)[0]?.ok).toBe(false)
  })
})
