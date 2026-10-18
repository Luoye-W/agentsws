/**
 * WP395（docs/106 §13 / docs/104 C2）：`position.plan` 与两条新断言。
 *
 * - DSL：`position.plan` / `positions_planned` / `position_answer_no_data` 解析得出来，写错键名当场报；
 * - 跑一遍 3 人 pack 那条题：划出「Amazon 运营」（亚马逊店铺运营 + Amazon 客服，A3），
 *   问补货照实说没数据（不出组件、不出数）；
 * - 断言真的会红：期望写错了它就不过。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseScenario, runScenario } from '../src/index.js'
import { PACK_DIR, pack, runPackScenario } from './helpers.js'

const BASE = `
id: t/amazon
version: 1
dataset: { pack: dtc-3c-3p, seed: 42 }
stand_ins: { provider: mock_open_connector, model: stub, clock: virtual, delivery: inbox }
clock: { start: '2026-10-18T09:00:00+08:00' }
events:
  - at: '+0m'
    position.plan: { who: p_li, text: 我们在 Amazon 上卖, roles: [amz.store, amz.support] }
expected:
  positions_planned:
    amazon-ops: [amz.store, amz.support]
  position_answer_no_data: [amz.store]
invariants: [prompt_replayable]
`

describe('DSL', () => {
  it('position.plan 与两条断言解析得出来', () => {
    const s = parseScenario(BASE, 'x.yml')
    const plan = s.events.find((e) => e.type === 'position.plan')
    expect(plan?.type === 'position.plan' ? plan.plan : undefined).toEqual({
      who: 'p_li',
      text: '我们在 Amazon 上卖',
      roles: ['amz.store', 'amz.support'],
    })
    expect(s.expected?.positions_planned).toEqual({ 'amazon-ops': ['amz.store', 'amz.support'] })
    expect(s.expected?.position_answer_no_data).toEqual(['amz.store'])
  })

  it('写错键名当场报；positions_planned 写成列表也报', () => {
    expect(() => parseScenario(BASE.replace('roles: [', 'role: ['), 'x.yml')).toThrow()
    expect(() =>
      parseScenario(
        BASE.replace(
          '  positions_planned:\n    amazon-ops: [amz.store, amz.support]',
          '  positions_planned: [amazon-ops]',
        ),
        'x.yml',
      ),
    ).toThrow(/模板 id/)
  })
})

describe('3 人 pack：卖 Amazon 的品牌种出 Amazon 运营', () => {
  it('划出 Amazon 运营两条；问补货、账户健康照实说没数据', async () => {
    const { report, evidence } = await runPackScenario('amazon/amazon-ops-position.yml')
    expect(report.passed).toBe(true)
    const planned = evidence.events.find((e) => e.type === 'simulation.position_planned')
    expect(planned).toBeDefined()
    expect((planned?.payload as { positions?: unknown } | undefined)?.positions).toEqual([
      { template_id: 'amazon-ops', role_ids: ['amz.store', 'amz.support'] },
    ])
    const answered = evidence.events
      .filter((e) => e.type === 'simulation.position_answered')
      .map((e) => e.payload as { role_id: string; components: unknown[]; no_data?: boolean })
    expect(answered).toHaveLength(2)
    for (const a of answered) {
      expect(a.role_id).toBe('amz.store')
      expect(a.components).toEqual([])
      expect(a.no_data).toBe(true)
    }
  })

  it('断言会红：期望写成「Amazon 客服留在客服」就不过', async () => {
    const text = readFileSync(`${PACK_DIR}/scenarios/amazon/amazon-ops-position.yml`, 'utf8')
    const wrong = text.replace(
      '    amazon-ops: [amz.store, amz.support]',
      '    customer-care: [amz.support]\n    amazon-ops: [amz.store]',
    )
    expect(wrong).not.toBe(text)
    const report = await runScenario(parseScenario(wrong, 'x.yml'), { pack: pack() })
    expect(report.passed).toBe(false)
    expect(report.expectations.find((e) => e.key === 'positions_planned')?.ok).toBe(false)
  })
})
