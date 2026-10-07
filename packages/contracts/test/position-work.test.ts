/** WP241（docs/54 §7）：工作项的分组规则与看板拖动规则——前后端同一份。 */
import { describe, expect, it } from 'vitest'
import {
  canMoveWorkItem,
  matterGroupOf,
  POSITION_WORK_GROUPS,
  postGroupOf,
  scheduleGroupOf,
  todoGroupOf,
  todoSourceOf,
  todoStatusForGroup,
} from '../src/position-work.js'

const NOW = '2026-10-06T08:00:00.000Z'

describe('分组', () => {
  it('五组的顺序 = 列表从上到下、看板从左到右（WP244 加「卡住了」，排在进行中后面）', () => {
    expect(POSITION_WORK_GROUPS).toEqual(['doing', 'stuck', 'queued', 'waiting', 'done'])
  })

  it('WP244：「卡住了」只收事项，待办拖不进去', () => {
    expect(canMoveWorkItem({ kind: 'todo', group: 'doing' }, 'stuck')).toBe(false)
    expect(canMoveWorkItem({ kind: 'matter', group: 'doing' }, 'stuck')).toBe(false)
    expect(todoStatusForGroup('stuck')).toBe('blocked')
  })

  it('事项：开着 = 进行中，等着 = 等别人，关了 = 已完成', () => {
    expect(matterGroupOf('open')).toBe('doing')
    expect(matterGroupOf('waiting')).toBe('waiting')
    expect(matterGroupOf('closed')).toBe('done')
  })

  it('待办：不做了的不进；排在以后的算排着的；卡住 = 等别人', () => {
    expect(todoGroupOf('dropped', undefined, NOW)).toBeUndefined()
    expect(todoGroupOf('open', undefined, NOW)).toBe('doing')
    expect(todoGroupOf('open', '2026-10-07T01:00:00.000Z', NOW)).toBe('queued')
    expect(todoGroupOf('open', '2026-10-05T01:00:00.000Z', NOW)).toBe('doing')
    expect(todoGroupOf('doing', '2026-10-07T01:00:00.000Z', NOW)).toBe('doing')
    expect(todoGroupOf('blocked', undefined, NOW)).toBe('waiting')
    expect(todoGroupOf('done', undefined, NOW)).toBe('done')
  })

  it('定时：开着 / 停着都算排着的，正在跑算进行中，取消了的不进', () => {
    expect(scheduleGroupOf('active')).toBe('queued')
    expect(scheduleGroupOf('paused')).toBe('queued')
    expect(scheduleGroupOf('running')).toBe('doing')
    expect(scheduleGroupOf('done')).toBe('done')
    expect(scheduleGroupOf('cancelled')).toBeUndefined()
  })

  it('排期：草稿在写 = 进行中，排好了 = 排着的，发了 = 已完成', () => {
    expect(postGroupOf('draft')).toBe('doing')
    expect(postGroupOf('scheduled')).toBe('queued')
    expect(postGroupOf('published')).toBe('done')
  })

  it('待办来源：手动加的 = 你交的；会议落下来的单列；其余算 Agent', () => {
    expect(todoSourceOf('manual')).toBe('you')
    expect(todoSourceOf('meeting')).toBe('meeting')
    expect(todoSourceOf('card')).toBe('agent')
  })
})

describe('看板拖动', () => {
  it('只有待办能拖；拖回原列不算动；「排着的」不收拖动（要给时间）', () => {
    expect(canMoveWorkItem({ kind: 'todo', group: 'doing' }, 'done')).toBe(true)
    expect(canMoveWorkItem({ kind: 'todo', group: 'doing' }, 'waiting')).toBe(true)
    expect(canMoveWorkItem({ kind: 'todo', group: 'done' }, 'queued')).toBe(false)
    expect(canMoveWorkItem({ kind: 'todo', group: 'doing' }, 'doing')).toBe(false)
    for (const kind of ['matter', 'schedule', 'post'] as const)
      expect(canMoveWorkItem({ kind, group: 'doing' }, 'done')).toBe(false)
  })

  it('拖到哪列改成哪个待办状态（与分组规则互逆）', () => {
    // 「排着的」「卡住了」不收拖动（WP244：卡住了只收事项），只看能拖进去的那几列
    for (const g of POSITION_WORK_GROUPS.filter((x) => x !== 'queued' && x !== 'stuck'))
      expect(todoGroupOf(todoStatusForGroup(g), undefined, NOW)).toBe(g)
    expect(todoStatusForGroup('queued')).toBe('open')
  })
})
