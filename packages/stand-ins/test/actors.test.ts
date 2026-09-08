import { seededRandom } from '@agentsws/kernel'
import { describe, expect, it } from 'vitest'
import { ActorPool, DEFAULT_EDIT_RULES, StandInError, SyntheticClock } from '../src/index.js'
import { FakeApprovalBus, WORKSPACE } from './helpers.js'

function bench(seed = 11) {
  const clock = new SyntheticClock('2026-09-07T09:00:00.000Z')
  const bus = new FakeApprovalBus(() => clock.now())
  const pool = new ActorPool({ clock, random: seededRandom(seed), bus })
  return { clock, bus, pool }
}

const draft = (body: string) => ({ channel: 'email', to: ['anna@example.com'], body })

describe('合成人：策略', () => {
  it('always_approve：到点就批', async () => {
    const { bus, pool } = bench()
    pool.add({ person_id: 'p_wang', workspace_id: WORKSPACE, policy: { kind: 'always_approve' } })
    bus.push({ id: 'ai_1', payload: draft('we will get back to you'), to: 'p_wang' })
    const made = await pool.tick()
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ action: 'approve', edited: false, latency_ms: 0 })
    expect(bus.items[0]?.state).toBe('approved')
    expect(bus.items[0]?.decision?.decision_token).toBe('dtok_1')
    // 已决定的不会被重复处理
    expect(await pool.tick()).toEqual([])
  })

  it('edit_pct(30)：200 条决定的编辑率 ≈ 0.3 ± 0.05', async () => {
    const { bus, pool } = bench(2026)
    pool.add({
      person_id: 'p_wang',
      workspace_id: WORKSPACE,
      policy: { kind: 'edit_pct', pct: 30 },
    })
    for (let i = 0; i < 200; i += 1) {
      bus.push({ id: `ai_${i}`, payload: draft('we will get back to you soon'), to: 'p_wang' })
    }
    const made = await pool.tick()
    expect(made).toHaveLength(200)
    const edited = made.filter((m) => m.action === 'approve_edited').length
    expect(edited / 200).toBeGreaterThanOrEqual(0.25)
    expect(edited / 200).toBeLessThanOrEqual(0.35)
    const editedItem = bus.items.find((i) => i.state === 'approved_edited')
    const payload = editedItem?.decision?.edited_payload as { body: string }
    expect(payload.body).toContain('we will reply within 24 hours')
  })

  it('reject_rules 命中即驳回并带 reason', async () => {
    const { bus, pool } = bench()
    pool.add({
      person_id: 'p_wang',
      workspace_id: WORKSPACE,
      policy: { kind: 'reject_rules', patterns: ['补偿'] },
    })
    bus.push({ id: 'ai_bad', payload: draft('我们额外给您补偿一张券'), to: 'p_wang' })
    bus.push({ id: 'ai_ok', payload: draft('已为您安排退款'), to: 'p_wang' })
    const made = await pool.tick()
    expect(made.map((m) => m.action)).toEqual(['reject', 'approve'])
    expect(made[0]?.reason).toBe('命中驳回规则：补偿')
    expect(bus.items[0]?.state).toBe('rejected')
    expect(bus.items[0]?.decision?.reason).toBe('命中驳回规则：补偿')
  })

  it('26 §1 的 `contains:` 前缀与"策略 + 驳回规则并存"都支持', async () => {
    const { bus, pool } = bench()
    pool.add({
      person_id: 'p_wang',
      workspace_id: WORKSPACE,
      policy: { kind: 'edit_pct', pct: 100 },
      reject_rules: ['contains:补偿'],
    })
    bus.push({ id: 'ai_1', payload: draft('给您补偿'), to: 'p_wang' })
    bus.push({ id: 'ai_2', payload: draft('Best regards'), to: 'p_wang' })
    const made = await pool.tick()
    expect(made.map((m) => m.action)).toEqual(['reject', 'approve_edited'])
  })

  it('标题与摘要也在驳回规则的匹配范围内', async () => {
    const { bus, pool } = bench()
    pool.add({
      person_id: 'p_wang',
      workspace_id: WORKSPACE,
      policy: { kind: 'reject_rules', patterns: ['价格'] },
    })
    bus.push({ id: 'ai_1', title: '改价格', payload: draft('ok'), to: 'p_wang' })
    const made = await pool.tick()
    expect(made[0]?.action).toBe('reject')
  })
})

describe('合成人：延迟', () => {
  it('slow(latency_range)：到点才决定，延迟落在范围内', async () => {
    const { clock, bus, pool } = bench(77)
    const min = 2 * 3600_000
    const max = 8 * 3600_000
    pool.add({
      person_id: 'p_wang',
      workspace_id: WORKSPACE,
      policy: { kind: 'slow', latency_ms: { min, max }, base: { kind: 'always_approve' } },
    })
    for (let i = 0; i < 20; i += 1) bus.push({ id: `ai_${i}`, payload: draft('ok'), to: 'p_wang' })

    expect(await pool.tick()).toEqual([])
    clock.advance(min - 1)
    expect(await pool.tick()).toEqual([])
    clock.advance(max)
    const made = await pool.tick()
    expect(made).toHaveLength(20)
    for (const m of made) {
      expect(m.latency_ms).toBeGreaterThanOrEqual(min)
      expect(m.latency_ms).toBeLessThanOrEqual(max)
      expect(Date.parse(m.at) - Date.parse(m.queued_at)).toBeGreaterThanOrEqual(m.latency_ms)
    }
    expect(new Set(made.map((m) => m.latency_ms)).size).toBeGreaterThan(1)
  })

  it('latency 字段与 slow 等价；非法范围报错', async () => {
    const { clock, bus, pool } = bench(5)
    pool.add({
      person_id: 'p_a',
      workspace_id: WORKSPACE,
      policy: { kind: 'always_approve' },
      latency: { min: 1000, max: 1000 },
    })
    bus.push({ id: 'ai_1', payload: draft('ok'), to: 'p_a' })
    expect(await pool.tick()).toEqual([])
    clock.advance(1000)
    expect((await pool.tick())[0]?.latency_ms).toBe(1000)

    pool.add({
      person_id: 'p_b',
      workspace_id: WORKSPACE,
      policy: { kind: 'always_approve' },
      latency: { min: 10, max: 1 },
    })
    bus.push({ id: 'ai_2', payload: draft('ok'), to: 'p_b' })
    await expect(pool.tick()).rejects.toThrow(StandInError)
  })
})

describe('合成人：装配与边界', () => {
  it('未绑定总线 / 非法参数 / 非法时刻', async () => {
    const clock = new SyntheticClock('2026-09-07T09:00:00.000Z')
    const pool = new ActorPool({ clock, random: seededRandom(1) })
    await expect(pool.tick()).rejects.toMatchObject({ code: 'invalid_input' })
    expect(() =>
      pool.add({ person_id: 'p', workspace_id: WORKSPACE, policy: { kind: 'edit_pct', pct: 120 } }),
    ).toThrow(StandInError)
    const bus = new FakeApprovalBus(() => clock.now())
    pool.attach(bus)
    pool.add({ person_id: 'p', workspace_id: WORKSPACE, policy: { kind: 'always_approve' } })
    expect(pool.list()).toHaveLength(1)
    await expect(pool.tick('not-a-time')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('没有 decision_token 的项跳过；总线报错记进 error', async () => {
    const { bus, pool } = bench()
    pool.add({ person_id: 'p_wang', workspace_id: WORKSPACE, policy: { kind: 'always_approve' } })
    const item = bus.push({ id: 'ai_1', payload: draft('ok'), to: 'p_wang' })
    item.deliveries = []
    const skipped = await pool.tick()
    expect(skipped[0]).toMatchObject({ action: 'skipped', reason: '没有可用的 decision_token' })

    const other = bus.push({ id: 'ai_2', payload: draft('ok'), to: 'p_wang' })
    const delivery = other.deliveries[0]
    if (delivery) delivery.status = 'acted'
    const failed = await pool.tick()
    const second = failed.find((f) => f.item_id === 'ai_2')
    expect(second).toMatchObject({ action: 'skipped' })
    expect(second?.error).toContain('已用')
    expect(pool.decisions()).toHaveLength(3)
  })

  it('只处理 pending / in_review 的项', async () => {
    const { bus, pool } = bench()
    pool.add({ person_id: 'p_wang', workspace_id: WORKSPACE, policy: { kind: 'always_approve' } })
    const item = bus.push({ id: 'ai_1', payload: draft('ok'), to: 'p_wang' })
    item.state = 'blocked'
    expect(await pool.tick()).toEqual([])
    item.state = 'in_review'
    expect(await pool.tick()).toHaveLength(1)
  })

  it('人类改法库：命中就替换，没命中就追加兜底', () => {
    const { pool } = bench()
    const replaced = pool.applyEdits({ body: 'Sorry for the inconvenience, Best regards' }) as {
      body: string
    }
    expect(replaced.body).toContain('we will make it right')
    expect(replaced.body).toContain('Kind regards')
    const appended = pool.applyEdits({ body: 'nothing to change' }) as { body: string }
    expect(appended.body).toContain('reviewed by ops')
    const noText = pool.applyEdits({ amount: 10 }) as { ops_note: string }
    expect(noText.ops_note).toBe('— reviewed by ops')
    expect(pool.applyEdits('Best regards')).toBe('Kind regards')
    expect(pool.applyEdits(42)).toBe(42)
    expect(DEFAULT_EDIT_RULES.length).toBeGreaterThan(0)
  })

  it('自定义改法库覆盖默认', async () => {
    const clock = new SyntheticClock('2026-09-07T09:00:00.000Z')
    const bus = new FakeApprovalBus(() => clock.now())
    const pool = new ActorPool({
      clock,
      random: seededRandom(3),
      bus,
      editRules: [{ find: 'hello', replace: 'hi' }],
      editFallback: ' [edited]',
    })
    pool.add({
      person_id: 'p_wang',
      workspace_id: WORKSPACE,
      policy: { kind: 'edit_pct', pct: 100 },
    })
    bus.push({ id: 'ai_1', payload: draft('hello there'), to: 'p_wang' })
    await pool.tick()
    const edited = bus.items[0]?.decision?.edited_payload as { body: string } | undefined
    expect(edited?.body).toBe('hi there')
  })
})
