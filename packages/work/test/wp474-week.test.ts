/**
 * WP474（决策 1531）：「本周」= 本周一 00:00 到周日 24:00（品牌时区），不再是「今天起 7 天」。
 * - 周日 23:59 与周一 00:00 的分档；
 * - 读的时候按现在重算（存的那一档不改写）；
 * - 没日子的「本周」跨了周还没做完 → 周一挪进新的「本周」，标「上周没做完」（`carried_over`，只算不存）。
 */
import type { Todo } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { deriveHorizon, effectiveHorizon, startOfWeek, viewTodo } from '../src/horizon.js'
import { createWork } from '../src/service.js'
import { MemoryWorkStore } from '../src/store.js'
import { FakeClock, seeded } from './helpers.js'

const TZ = 480
/** 北京时间 2026-10-<day> hh:mm → ISO（10-19 周一 … 10-25 周日、10-26 周一） */
const bj = (day: number, hh: number, mm = 0): string =>
  new Date(Date.UTC(2026, 9, day, hh - 8, mm)).toISOString()

const SUN_2359 = bj(25, 23, 59)
const MON_0000 = bj(26, 0, 0)

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: 'td_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  title: '给工厂确认备货量',
  owner: 'per_1',
  horizon: 'week',
  source: 'manual',
  status: 'open',
  cards: [],
  runs: [],
  created_at: bj(22, 10),
  updated_at: bj(22, 10),
  ...over,
})

describe('本周 = 周一到周日（WP474）', () => {
  it('周一 00:00 是这一周的起点（品牌时区）', () => {
    expect(new Date(startOfWeek(Date.parse(SUN_2359), TZ)).toISOString()).toBe(bj(19, 0))
    expect(new Date(startOfWeek(Date.parse(MON_0000), TZ)).toISOString()).toBe(bj(26, 0))
    expect(new Date(startOfWeek(Date.parse(bj(22, 15)), TZ)).toISOString()).toBe(bj(19, 0))
  })

  it('周日 23:59：周日到期算今天，下周一到期算「以后」（本周只剩当天）', () => {
    expect(deriveHorizon({ due: bj(25, 20) }, SUN_2359, TZ)).toBe('today')
    expect(deriveHorizon({ due: bj(26, 12) }, SUN_2359, TZ)).toBe('backlog')
    expect(deriveHorizon({ scheduled: { start: bj(26, 9), end: bj(26, 10) } }, SUN_2359, TZ)).toBe(
      'backlog',
    )
  })

  it('周一 00:00：周一算今天，周二到周日都是本周，下周一是以后', () => {
    expect(deriveHorizon({ due: bj(26, 12) }, MON_0000, TZ)).toBe('today')
    expect(deriveHorizon({ due: bj(27, 12) }, MON_0000, TZ)).toBe('week')
    expect(
      deriveHorizon({ due: new Date(Date.UTC(2026, 10, 1, 15, 59)).toISOString() }, MON_0000, TZ),
    ).toBe('week')
    expect(
      deriveHorizon({ due: new Date(Date.UTC(2026, 10, 1, 16, 0)).toISOString() }, MON_0000, TZ),
    ).toBe('backlog')
  })

  it('周四看下周三：以前滚动 7 天算本周，现在是以后', () => {
    expect(deriveHorizon({ due: bj(28, 12) }, bj(22, 10), TZ)).toBe('backlog')
    expect(deriveHorizon({ due: bj(25, 12) }, bj(22, 10), TZ)).toBe('week')
  })
})

describe('读的时候按新口径算（老数据不改写）', () => {
  it('有日子的按现在重算：上周四按滚动口径存成「本周」的下周二那件，读出来是「以后」', () => {
    const old = todo({ horizon: 'week', due: bj(27, 12) })
    expect(effectiveHorizon(old, bj(22, 10), TZ).horizon).toBe('backlog')
    // 到了那一周的周一就进本周
    expect(effectiveHorizon(old, MON_0000, TZ).horizon).toBe('week')
    // 当天就是今天
    expect(effectiveHorizon(old, bj(27, 8), TZ).horizon).toBe('today')
  })

  it('有日子的、今天手动提到「今天」的当天照旧算今天，第二天按日子算', () => {
    const promoted = todo({ horizon: 'today', due: bj(24, 12), horizon_at: bj(22, 9) })
    expect(effectiveHorizon(promoted, bj(22, 18), TZ).horizon).toBe('today')
    expect(effectiveHorizon(promoted, bj(23, 9), TZ).horizon).toBe('week')
  })

  it('没日子的「本周」：同一周照旧；周日 23:59 还在本周，周一 00:00 挪进新的本周并标「上周没做完」', () => {
    const t = todo({ horizon: 'week', horizon_at: bj(22, 10) })
    expect(effectiveHorizon(t, SUN_2359, TZ)).toEqual({ horizon: 'week', carried_over: false })
    expect(effectiveHorizon(t, MON_0000, TZ)).toEqual({ horizon: 'week', carried_over: true })
  })

  it('周日晚上记的「本周」只剩当天：周一就算上周没做完', () => {
    const t = todo({ horizon: 'week', horizon_at: bj(25, 22), created_at: bj(25, 22) })
    expect(effectiveHorizon(t, SUN_2359, TZ).carried_over).toBe(false)
    expect(effectiveHorizon(t, MON_0000, TZ).carried_over).toBe(true)
  })

  it('老待办没有 horizon_at：看 updated_at', () => {
    const t = todo({ horizon: 'week', updated_at: bj(20, 9) })
    expect(effectiveHorizon(t, bj(24, 9), TZ).carried_over).toBe(false)
    expect(effectiveHorizon(t, MON_0000, TZ).carried_over).toBe(true)
  })

  it('没日子的「今天」：当天照旧，过了那天回本周，跨周同本周（标上周没做完）', () => {
    const t = todo({ horizon: 'today', horizon_at: bj(22, 9) })
    expect(effectiveHorizon(t, bj(22, 20), TZ)).toEqual({ horizon: 'today', carried_over: false })
    expect(effectiveHorizon(t, bj(23, 9), TZ)).toEqual({ horizon: 'week', carried_over: false })
    expect(effectiveHorizon(t, MON_0000, TZ)).toEqual({ horizon: 'week', carried_over: true })
  })

  it('定在「将来」的（时钟往回拨）不算过期：照存的那一档', () => {
    const t = todo({ horizon: 'today', horizon_at: bj(22, 10) })
    expect(effectiveHorizon(t, bj(21, 10), TZ)).toEqual({ horizon: 'today', carried_over: false })
  })

  it('「以后」不动；做完的不标', () => {
    expect(effectiveHorizon(todo({ horizon: 'backlog' }), MON_0000, TZ).horizon).toBe('backlog')
    expect(effectiveHorizon(todo({ status: 'done' }), MON_0000, TZ).carried_over).toBe(false)
  })

  it('viewTodo 只改读出去的那一份', () => {
    const t = todo({ horizon: 'week', horizon_at: bj(22, 10) })
    const v = viewTodo(t, MON_0000, TZ)
    expect(v.carried_over).toBe(true)
    expect(t.carried_over).toBeUndefined()
    expect(viewTodo(todo({ horizon_at: bj(26, 9) }), bj(26, 10), TZ)).not.toHaveProperty(
      'carried_over',
    )
  })
})

describe('服务层：列表 / 待办箱 / 按分档筛都按现在算（WP474）', () => {
  function make(start: string) {
    const clock = new FakeClock(start)
    const store = new MemoryWorkStore()
    const work = createWork({
      workspace_id: 'ws_1',
      clock,
      random: seeded(7),
      tz_offset_minutes: TZ,
      store,
    })
    return { work, clock, store }
  }

  it('周四记的「本周」，下周一读出来在本周、标上周没做完；存的那一份不带这个标', () => {
    const { work, clock, store } = make(bj(22, 10))
    const t = work.createTodo({ title: '回 Leo 的合作邮件', owner: 'per_1', horizon: 'week' })
    expect(t.horizon_at).toBe(bj(22, 10))
    expect(work.inbox('per_1').week.map((x) => x.id)).toEqual([t.id])
    clock.set(MON_0000)
    const week = work.inbox('per_1').week
    expect(week.map((x) => x.id)).toEqual([t.id])
    expect(week[0]?.carried_over).toBe(true)
    expect(work.getTodo(t.id)?.carried_over).toBe(true)
    // 改个字：存的那一份不带 carried_over，读出来照旧标
    const edited = work.updateTodo(t.id, { title: '回 Leo 的合作邮件（报价）' })
    expect(edited.carried_over).toBe(true)
    expect(store.getTodo(t.id)?.carried_over).toBeUndefined()
    // 重新明说放进本周 = 这一周定的，不再标
    const again = work.updateTodo(t.id, { horizon: 'week' })
    expect(again.carried_over).toBeUndefined()
    expect(again.horizon_at).toBe(MON_0000)
  })

  it('按分档筛在重算之后：上周存成「本周」的下周二那件不再出现在「本周」里', () => {
    const { work, clock } = make(bj(22, 10))
    const dated = work.createTodo({ title: '拍样品', owner: 'per_1', due: bj(27, 12) })
    // 周四看下周二：以后
    expect(dated.horizon).toBe('backlog')
    expect(work.listTodos({ horizon: ['week'] }).map((x) => x.id)).toEqual([])
    clock.set(bj(27, 8))
    expect(work.listTodos({ horizon: ['today'] }).map((x) => x.id)).toEqual([dated.id])
  })
})
