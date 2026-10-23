/**
 * WP474（决策 1530）：「我的作息」影响「帮我排进空档」的候选——工作时段、周末、直播前后留空、避开午饭。
 * 不给作息 = WP469 那套默认（9–18、不排周末、直播前后 30 分钟、不避午饭）。
 */
import { type CalendarItem, DEFAULT_WORK_HOURS, type Todo } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { normalizeWorkHours, proposeSlots, slotStarts } from '../src/slots.js'

const TZ = 480
const bj = (day: number, hh: number, mm = 0): string =>
  new Date(Date.UTC(2026, 8, day, hh - 8, mm)).toISOString()
/** 2026-09-07 周一 00:00 到下周一 00:00（北京） */
const WEEK = { from: '2026-09-06T16:00:00.000Z', to: '2026-09-13T16:00:00.000Z' }
const localMin = (s: number): number => {
  const d = new Date(s + TZ * 60_000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}
const weekday = (s: number): number => new Date(s + TZ * 60_000).getUTCDay()

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: 'a',
  schema_version: 1,
  workspace_id: 'ws_1',
  title: '给工厂确认备货量',
  owner: 'per_1',
  horizon: 'week',
  source: 'manual',
  status: 'open',
  cards: [],
  runs: [],
  created_at: bj(7, 8),
  updated_at: bj(7, 8),
  ...over,
})

const live = (start: string, end: string): CalendarItem => ({
  id: `cal_${start}`,
  source: 'meeting',
  title: '直播',
  start,
  end,
  all_day: false,
  ref: { type: 'meeting', id: start },
})

describe('我的作息影响候选（WP474）', () => {
  it('工作时段：10:00–19:30 就只在这一段里', () => {
    const hours = { ...DEFAULT_WORK_HOURS, start_min: 600, end_min: 1170 }
    const starts = slotStarts({ ...WEEK, now: bj(7, 0), tz_offset_minutes: TZ, hours })
    expect(localMin(starts[0] as number)).toBe(600)
    for (const s of starts) {
      expect(localMin(s)).toBeGreaterThanOrEqual(600)
      expect(localMin(s)).toBeLessThan(1170)
    }
    // 一小时的事最晚 18:30 开始（19:30 前做完）
    const out = proposeSlots({
      todos: [todo()],
      items: [],
      from: bj(7, 18, 30),
      to: bj(8, 0),
      now: bj(7, 18, 30),
      tz_offset_minutes: TZ,
      hours,
    })
    expect(out.proposals[0]?.options).toEqual([{ start: bj(7, 18, 30), end: bj(7, 19, 30) }])
  })

  it('周末：默认不排，打开就排', () => {
    const off = slotStarts({ ...WEEK, now: bj(7, 0), tz_offset_minutes: TZ })
    expect(off.some((s) => weekday(s) === 0 || weekday(s) === 6)).toBe(false)
    const on = slotStarts({
      ...WEEK,
      now: bj(7, 0),
      tz_offset_minutes: TZ,
      hours: { ...DEFAULT_WORK_HOURS, weekends: true },
    })
    expect(on.some((s) => weekday(s) === 6)).toBe(true)
    expect(on.some((s) => weekday(s) === 0)).toBe(true)
  })

  it('直播前后留空：默认 30 分钟，改成 0 就紧挨着', () => {
    const items = [live(bj(7, 10), bj(7, 11))]
    const base = {
      todos: [todo()],
      items,
      from: bj(7, 9),
      to: bj(7, 18),
      now: bj(7, 9),
      tz_offset_minutes: TZ,
    }
    // 默认：9:00–10:00 撞直播前半小时 → 11:30
    expect(proposeSlots(base).proposals[0]?.options[0]?.start).toBe(bj(7, 11, 30))
    // 不留：9:00 就行
    const none = proposeSlots({ ...base, hours: { ...DEFAULT_WORK_HOURS, live_buffer_min: 0 } })
    expect(none.proposals[0]?.options[0]?.start).toBe(bj(7, 9))
    // 留 60 分钟：直播后 12:00 起
    const wide = proposeSlots({
      ...base,
      now: bj(7, 10),
      from: bj(7, 10),
      hours: { ...DEFAULT_WORK_HOURS, live_buffer_min: 60 },
    })
    expect(wide.proposals[0]?.options[0]?.start).toBe(bj(7, 12))
  })

  it('避开午饭：12:00–13:00 不给，默认不避', () => {
    const base = {
      todos: [todo()],
      items: [],
      from: bj(7, 11, 30),
      to: bj(7, 18),
      now: bj(7, 11, 30),
      tz_offset_minutes: TZ,
    }
    expect(proposeSlots(base).proposals[0]?.options[0]?.start).toBe(bj(7, 11, 30))
    const out = proposeSlots({ ...base, hours: { ...DEFAULT_WORK_HOURS, avoid_lunch: true } })
    const opts = out.proposals[0]?.options ?? []
    expect(opts[0]?.start).toBe(bj(7, 13))
    for (const o of opts) {
      const s = localMin(Date.parse(o.start))
      const e = localMin(Date.parse(o.end))
      expect(e <= 720 || s >= 780).toBe(true)
    }
  })

  it('存坏了的作息读成默认', () => {
    expect(normalizeWorkHours(undefined)).toEqual(DEFAULT_WORK_HOURS)
    expect(normalizeWorkHours({ start_min: 1200, end_min: 600, weekends: 'x' })).toEqual(
      DEFAULT_WORK_HOURS,
    )
    expect(
      normalizeWorkHours({
        start_min: 480,
        end_min: 1020,
        live_buffer_min: 999,
        avoid_lunch: true,
      }),
    ).toEqual({ ...DEFAULT_WORK_HOURS, start_min: 480, end_min: 1020, avoid_lunch: true })
  })
})
