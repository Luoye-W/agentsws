/**
 * WP244（Fable 10-07 真机，INMO Reddit 运营）：工作列表里「查完了」的事项一直挂在「进行中 · AI 在做」，
 * 「这份活现在交不出来——不是没人干，是没接上」的那条也挂在进行中。
 *
 * 查清的根因：**是 WP241 合成视图的分组规则**，不是事项没收口——事项（37 Matter）只有
 * 开着 / 等着 / 关了，一轮运行跑完它照样「开着」（人还能接着说），而分组把「开着」一律算进行中。
 * 改成看最近那一轮运行：在跑 = 进行中；答完了 = 已完成（待你看结果）；没跑成 / 被停 / 它自己说
 * 缺连接 = 卡住了，并说缺什么。
 */
import type { Matter, MatterEvent } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { buildPositionWork, matterRunStateOf, openMatterPhase } from '../src/position-work.js'

const NOW = '2026-10-07T12:00:00.000Z'

const matter = (over: Partial<Matter>): Matter => ({
  id: 'm_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'adhoc',
  title: '查一下近视求助帖',
  status: 'open',
  role_id: 'social.reddit',
  context: { summary: '', pinned: [], participants: [], last_activity: NOW },
  created_at: NOW,
  updated_at: NOW,
  ...over,
})

type Ev = Pick<MatterEvent, 'kind' | 'text' | 'run_id' | 'stopped'>

/** 同步跑的那一路：人话 → Agent 的答复（带 run_id）→ 跑完才记的「开始跑了」。 */
const answered = (text: string, run_id = 'run_1'): Ev[] => [
  { kind: 'human_message', text: '帮我查一下' },
  { kind: 'agent_message', text, run_id },
  { kind: 'run', text: 'Agent 接着这个事项跑了一次', run_id },
]

const base = {
  position_id: 'social-media',
  now: NOW,
  today: { from: '2026-10-07T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
  duties: [{ role_id: 'social.reddit', role_name: '自家版运营', assignment_id: 'asg_social' }],
  todos: [],
  schedules: [],
  posts: [],
  cards: [],
  roleName: (id: string) => id,
  roleOfAssignment: () => undefined,
}

describe('WP244 · 最近那一轮运行怎么收的尾', () => {
  it('答完了：answered + 那句答复（按 run_id 认，不怕「开始跑了」记在答复后面）', () => {
    const s = matterRunStateOf(answered('查完了。'), false)
    expect(s.last).toEqual({ outcome: 'answered', text: '查完了。' })
  })

  it('没跑成 / 被停了：failed / stopped', () => {
    expect(
      matterRunStateOf(
        [{ kind: 'status', text: '这次运行没跑成：model.provider_down', run_id: 'r' }],
        false,
      ).last?.outcome,
    ).toBe('failed')
    expect(
      matterRunStateOf(
        [{ kind: 'status', text: '停了：太久没动静', run_id: 'r', stopped: { reason: 'idle' } }],
        false,
      ).last?.outcome,
    ).toBe('stopped')
  })

  it('只看最近那一轮：上一轮没跑成、这一轮答完了 → 答完了', () => {
    const s = matterRunStateOf(
      [
        { kind: 'status', text: '这次运行没跑成：x', run_id: 'r1' },
        ...answered('这回查完了。', 'r2'),
      ],
      false,
    )
    expect(s.last?.outcome).toBe('answered')
  })

  it('从没跑过：没有 last', () => {
    expect(matterRunStateOf([{ kind: 'human_message', text: '记一下' }], false).last).toBe(
      undefined,
    )
  })
})

describe('WP244 · 开着的事项落哪一组', () => {
  it('在跑 → 进行中；不知道 → 进行中（老口径）', () => {
    expect(openMatterPhase({ running: true, last: { outcome: 'answered', text: 'x' } }, 0)).toEqual(
      { group: 'doing' },
    )
    expect(openMatterPhase(undefined, 0)).toEqual({ group: 'doing' })
  })

  it('答完了、没卡等你 → 已完成，标「待你看结果」；有卡等你 → 仍在进行中（行尾 N 张卡等你）', () => {
    const s = { running: false, last: { outcome: 'answered' as const, text: '查完了。' } }
    expect(openMatterPhase(s, 0)).toEqual({ group: 'done', result_ready: true })
    expect(openMatterPhase(s, 1)).toEqual({ group: 'doing' })
  })

  it('它自己说交不出来 / 没接上 → 卡住了；知道缺哪条连接就说缺哪条', () => {
    const text = '这份活现在交不出来——不是没人干，是没接上。'
    expect(openMatterPhase({ running: false, last: { outcome: 'answered', text } }, 0)).toEqual({
      group: 'stuck',
      stuck_reason: text,
    })
    expect(
      openMatterPhase(
        { running: false, last: { outcome: 'answered', text }, missing: ['Reddit'] },
        0,
      ),
    ).toEqual({ group: 'stuck', stuck_reason: '缺Reddit连接' })
  })
})

describe('WP244 · 工作视图：真机那两条', () => {
  it('「查完了」进已完成（待你看结果），「没接上」进卡住了并说缺什么；在跑的留在进行中', () => {
    const events: Record<string, Ev[]> = {
      m_done: answered('查完了。'),
      m_stuck: answered('这份活现在交不出来——不是没人干，是没接上。'),
      m_running: [{ kind: 'human_message', text: '再查一轮' }],
    }
    const view = buildPositionWork({
      ...base,
      matters: [
        matter({ id: 'm_done', title: '查近视求助帖' }),
        matter({ id: 'm_stuck', title: '回版主私信' }),
        matter({ id: 'm_running', title: '整理本周热帖' }),
      ],
      runOf: (m) =>
        matterRunStateOf(
          events[m.id] ?? [],
          m.id === 'm_running',
          m.id === 'm_stuck' ? ['Reddit'] : undefined,
        ),
    })
    const byId = new Map(view.items.map((i) => [i.ref_id, i]))
    expect(byId.get('m_done')).toMatchObject({ group: 'done', result_ready: true })
    expect(byId.get('m_stuck')).toMatchObject({ group: 'stuck', stuck_reason: '缺Reddit连接' })
    expect(byId.get('m_running')?.group).toBe('doing')
    expect(view.counts).toMatchObject({ doing: 1, stuck: 1, done: 1 })
    // 排序：进行中 → 卡住了 → … → 已完成
    expect(view.items.map((i) => i.group)).toEqual(['doing', 'stuck', 'done'])
  })

  it('没给运行情况（老装配）：开着的照旧算进行中', () => {
    const view = buildPositionWork({ ...base, matters: [matter({ id: 'm_x' })] })
    expect(view.items[0]?.group).toBe('doing')
    expect(view.items[0]?.result_ready).toBeUndefined()
  })
})
