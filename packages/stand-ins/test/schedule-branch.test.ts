/**
 * WP181：stub 的「自动化任务」岔口——只有工具面里有 `schedule_create` 才走；到点那次运行不走；
 * 中文里的「每天 / 工作日 / 每周几 / N 分钟后 / 下午 3 点半」认得出。
 */
import { describe, expect, it } from 'vitest'
import { renderScheduleAnswer, SCHEDULE_TOOL_NAMES, scheduleBranch } from '../src/index.js'

const ALL = [...SCHEDULE_TOOL_NAMES]

describe('scheduleBranch', () => {
  it('工具面里没有 → 不走（没装官方插件的运行一个字节不变）', () => {
    expect(scheduleBranch(['get_order'], '每天 9 点提醒我')).toBeUndefined()
  })

  it('到点那次运行（官方外框）不走——不然每天又建一条', () => {
    expect(scheduleBranch(ALL, '[SCHEDULE REMINDER BATCH]\n每天 9 点提醒我')).toBeUndefined()
  })

  it('认得出几种说法', () => {
    expect(scheduleBranch(ALL, '每天早上 9 点提醒我看订单')).toMatchObject({
      daily: { time: '09:00:00' },
    })
    expect(scheduleBranch(ALL, '每天下午 3 点半提醒我')).toMatchObject({
      daily: { time: '15:30:00' },
    })
    expect(scheduleBranch(ALL, '工作日 10 点提醒我开站会')).toMatchObject({
      weekly: { time: '10:00:00', weekdays: [1, 2, 3, 4, 5] },
    })
    expect(scheduleBranch(ALL, '每周一、三 9 点看周报')).toMatchObject({
      weekly: { time: '09:00:00', weekdays: [1, 3] },
    })
    expect(scheduleBranch(ALL, '30 分钟后提醒我回电话')).toMatchObject({ after_seconds: 1800 })
    expect(scheduleBranch(ALL, '帮我看看这单')).toBeUndefined()
  })

  it('回话：设成 / 等批 / 没设成', () => {
    expect(renderScheduleAnswer({ title: '看订单', scheduledAt: 'x' })).toContain('设好了')
    expect(renderScheduleAnswer({ title: '周报', approval: 'pending' })).toContain('出了一张卡')
    expect(renderScheduleAnswer({ code: 'not_future', message: '时间过了' })).toContain('没设成')
  })
})
