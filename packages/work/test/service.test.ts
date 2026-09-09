/**
 * 服务层：事项 / 待办 / 委托 / 卡片回填 / 目标 / 日历 / 计划 / 复盘。
 *
 * 37 的几条硬约束在这里钉住：
 * - 事项是唯一的上下文容器；待办与卡片都只是指针
 * - 计划只是建议，采纳才写待办
 * - 关闭事项时未完待办不自动关，由调用方选「一并关闭 / 保留」
 */
import type { Matter, StartRun } from '@agentsws/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cardRefOf, createWork, TIMELINE_PAGE, Work } from '../src/service.js'
import { SqliteWorkStore } from '../src/sqlite-store.js'
import { DAY_MS, plusMs } from '../src/util.js'
import { approval, FakeClock, seeded, T0 } from './helpers.js'

const TZ = 480

interface Harness {
  work: Work
  clock: FakeClock
  runs: { matter: Matter; brief: string; todo_id?: string }[]
}

function make(options: { startRun?: boolean; summarize?: boolean } = {}): Harness {
  const clock = new FakeClock()
  const runs: Harness['runs'] = []
  const startRun: StartRun = (input) => {
    runs.push({
      matter: input.matter,
      brief: input.brief,
      ...(input.todo_id === undefined ? {} : { todo_id: input.todo_id }),
    })
    return { run_id: `run_${runs.length}` }
  }
  const work = createWork({
    workspace_id: 'ws_1',
    clock,
    random: seeded(7),
    tz_offset_minutes: TZ,
    ...(options.startRun === false ? {} : { startRun }),
    ...(options.summarize === true
      ? { summarize: (i: { matter: Matter; run_summary: string }) => `[摘要] ${i.run_summary}` }
      : {}),
  })
  return { work, clock, runs }
}

describe('事项：上下文的家（37 §2.2b）', () => {
  let h: Harness
  beforeEach(() => {
    h = make()
  })

  it('建事项 → 默认 open、空摘要、last_activity = 现在', () => {
    const m = h.work.createMatter({ kind: 'conversation', title: 'Anna 的退货请求' })
    expect(m.status).toBe('open')
    expect(m.context.summary).toBe('')
    expect(m.context.last_activity).toBe(T0)
    expect(h.work.getMatter(m.id)?.title).toBe('Anna 的退货请求')
    expect(h.work.listMatters({ kind: 'conversation' })).toHaveLength(1)
  })

  it('可选字段齐全时都带上', () => {
    const m = h.work.createMatter({
      kind: 'project',
      title: '新品页',
      position_id: 'asg_1',
      goal_id: 'goal_1',
      summary: '刚开始',
      pinned: [{ type: 'order', id: 'ord_1' }],
      participants: ['per_1'],
      status: 'waiting',
    })
    expect(m).toMatchObject({ position_id: 'asg_1', goal_id: 'goal_1', status: 'waiting' })
    expect(m.context.pinned).toHaveLength(1)
  })

  it('找不到的事项抛 not_found', () => {
    expect(h.work.getMatter('nope')).toBeUndefined()
    expect(() => h.work.requireMatter('nope')).toThrowError(/没有这个事项/)
  })

  it('进入事项只加载摘要 + 固定记录展示名 + 最近 20 条时间线', () => {
    const m = h.work.createMatter({
      kind: 'conversation',
      title: 'T',
      pinned: [{ type: 'order', id: 'ord_1001' }],
    })
    for (let i = 0; i < 25; i += 1) {
      h.clock.advance(60_000)
      h.work.appendEvent(m.id, {
        kind: 'note',
        text: `第 ${i} 条`,
        actor: { kind: 'system', id: 's' },
      })
    }
    const view = h.work.matterView(m.id, {
      label: (ref) => (ref.id === 'ord_1001' ? '#1001' : undefined),
    })
    expect(view.timeline).toHaveLength(TIMELINE_PAGE)
    expect(view.timeline[TIMELINE_PAGE - 1]?.text).toBe('第 24 条')
    expect(view.has_more).toBe(true)
    expect(view.pinned_labels).toEqual([{ ref: { type: 'order', id: 'ord_1001' }, label: '#1001' }])

    // 没给 label 时退回 type:id，不猜
    const bare = h.work.matterView(m.id, { limit: 100 })
    expect(bare.has_more).toBe(false)
    expect(bare.pinned_labels[0]?.label).toBe('order:ord_1001')
  })

  it('追加时间线会把事项的 last_activity 推到那一刻；事件字段全带', () => {
    const m = h.work.createMatter({ kind: 'adhoc', title: 'T' })
    h.clock.advance(3_600_000)
    const ev = h.work.appendEvent(m.id, {
      kind: 'card',
      text: '一张卡',
      actor: { kind: 'agent', id: 'a' },
      ref: { type: 'order', id: 'o' },
      run_id: 'run_9',
      approval_item_id: 'apr_9',
      todo_id: 'td_9',
      at: '2026-09-09T05:00:00.000Z',
    })
    expect(ev.at).toBe('2026-09-09T05:00:00.000Z')
    expect(ev).toMatchObject({ run_id: 'run_9', approval_item_id: 'apr_9', todo_id: 'td_9' })
    expect(h.work.getMatter(m.id)?.context.last_activity).toBe('2026-09-09T05:00:00.000Z')
  })

  it('固定记录：加过的不重复加', () => {
    const m = h.work.createMatter({ kind: 'adhoc', title: 'T' })
    h.work.pin(m.id, { type: 'order', id: 'o1' })
    h.work.pin(m.id, { type: 'order', id: 'o1' })
    expect(h.work.getMatter(m.id)?.context.pinned).toHaveLength(1)
    h.work.pin(m.id, { type: 'customer', id: 'c1' })
    expect(h.work.getMatter(m.id)?.context.pinned).toHaveLength(2)
  })

  it('在事项里说话 = 记时间线 + 起 Run（第四处对话入口）', async () => {
    const m = h.work.createMatter({ kind: 'conversation', title: 'T' })
    const { event, run_id } = await h.work.say(m.id, {
      person_id: 'per_1',
      assignment_id: 'asg_1',
      text: '帮我查一下这单到哪了',
    })
    expect(event.kind).toBe('human_message')
    expect(run_id).toBe('run_1')
    expect(h.runs[0]?.brief).toBe('帮我查一下这单到哪了')
    expect(h.work.matterView(m.id).timeline.map((e) => e.kind)).toEqual(['human_message', 'run'])
  })

  it('没装运行时的进程：说话只记时间线，不起 Run', async () => {
    const bare = make({ startRun: false })
    const m = bare.work.createMatter({ kind: 'conversation', title: 'T' })
    const { run_id } = await bare.work.say(m.id, {
      person_id: 'per_1',
      assignment_id: 'asg_1',
      text: 'hi',
    })
    expect(run_id).toBeUndefined()
    expect(bare.work.matterView(m.id).timeline).toHaveLength(1)
  })

  it('运行结束更新摘要与会话引用；注入的 summarize 生效', () => {
    const m = h.work.createMatter({ kind: 'conversation', title: 'T' })
    h.clock.advance(1000)
    const updated = h.work.updateSummary(m.id, {
      run_summary: '已给退货标签，等客户寄回',
      session_ref: { runtime: 'dsh', session_id: 'ses_1' },
      run_id: 'run_1',
    })
    expect(updated.context.summary).toBe('已给退货标签，等客户寄回')
    expect(updated.context.session_ref?.session_id).toBe('ses_1')

    const custom = make({ summarize: true })
    const m2 = custom.work.createMatter({ kind: 'conversation', title: 'T' })
    expect(custom.work.updateSummary(m2.id, { run_summary: 'x' }).context.summary).toBe('[摘要] x')
  })

  it('关闭事项：未完待办「一并关闭」与「保留」两条路', () => {
    const m = h.work.createMatter({ kind: 'project', title: 'P' })
    h.work.createTodo({ title: 'A', owner: 'per_1', matter_id: m.id })
    h.work.createTodo({ title: 'B', owner: 'per_1', matter_id: m.id })
    const kept = h.work.closeMatter(m.id, { unfinished: 'keep', by: 'per_1' })
    expect(kept.matter.status).toBe('closed')
    expect(kept.closed_todo_ids).toEqual([])
    expect(kept.kept_todo_ids).toHaveLength(2)
    expect(h.work.listTodos({ matter_id: m.id }).every((t) => t.status === 'open')).toBe(true)
    expect(h.work.matterView(m.id).timeline.at(-1)?.text).toContain('保留在待办箱')

    const m2 = h.work.createMatter({ kind: 'project', title: 'Q' })
    h.work.createTodo({ title: 'C', owner: 'per_1', matter_id: m2.id })
    h.work.createTodo({ title: 'D', owner: 'per_1', matter_id: m2.id, status: undefined })
    const closed = h.work.closeMatter(m2.id, { unfinished: 'close_all' })
    expect(closed.closed_todo_ids).toHaveLength(2)
    expect(closed.kept_todo_ids).toEqual([])
    expect(h.work.listTodos({ matter_id: m2.id }).every((t) => t.status === 'dropped')).toBe(true)
    expect(h.work.matterView(m2.id).timeline.at(-1)?.text).toContain('一并关掉')
  })
})

describe('待办：人的承诺，指向事项的指针（37 §2.2）', () => {
  let h: Harness
  beforeEach(() => {
    h = make()
  })

  it('建待办时推 horizon；挂了事项的会在时间线上留一条', () => {
    const m = h.work.createMatter({ kind: 'project', title: 'P' })
    const long = h.work.createTodo({ title: '长期', owner: 'per_1' })
    expect(long.horizon).toBe('backlog')
    const soon = h.work.createTodo({
      title: '今天',
      owner: 'per_1',
      matter_id: m.id,
      due: plusMs(T0, 3_600_000),
      note: '记得带图',
      position_id: 'asg_1',
      goal_id: 'goal_1',
      anchor: { matter_event_id: 'mev_1' },
      source: 'meeting',
      origin: { meeting_id: 'mtg_1' },
    })
    expect(soon.horizon).toBe('today')
    expect(soon.anchor?.matter_event_id).toBe('mev_1')
    expect(h.work.matterView(m.id).timeline.map((e) => e.kind)).toEqual(['todo'])
    expect(h.work.matterView(m.id).todos.map((t) => t.id)).toEqual([soon.id])
  })

  it('挂到不存在的事项上会被拒', () => {
    expect(() => h.work.createTodo({ title: 'x', owner: 'per_1', matter_id: 'nope' })).toThrowError(
      /没有这个事项/,
    )
    expect(() => h.work.requireTodo('nope')).toThrowError(/没有这个待办/)
    expect(h.work.getTodo('nope')).toBeUndefined()
  })

  it('待办箱三段：backlog / 本周 / 今天，只算未完的', () => {
    h.work.createTodo({ title: 'A', owner: 'per_1' })
    h.work.createTodo({ title: 'B', owner: 'per_1', due: plusMs(T0, 3 * DAY_MS) })
    const c = h.work.createTodo({ title: 'C', owner: 'per_1', due: T0 })
    h.work.createTodo({ title: 'D', owner: 'per_2' })
    h.work.complete(c.id)
    const box = h.work.inbox('per_1')
    expect(box.backlog.map((t) => t.title)).toEqual(['A'])
    expect(box.week.map((t) => t.title)).toEqual(['B'])
    expect(box.today).toEqual([])
    expect(h.work.inbox().backlog.map((t) => t.title)).toEqual(['A', 'D'])
  })

  it('改待办：清空 due / scheduled / goal / position，重推 horizon', () => {
    const t = h.work.createTodo({
      title: 'A',
      owner: 'per_1',
      due: T0,
      goal_id: 'goal_1',
      position_id: 'asg_1',
    })
    expect(t.horizon).toBe('today')
    const cleared = h.work.updateTodo(t.id, {
      due: null,
      goal_id: null,
      position_id: null,
      note: '换个说法',
      title: 'A2',
    })
    expect(cleared.horizon).toBe('backlog')
    expect(cleared.due).toBeUndefined()
    expect(cleared.goal_id).toBeUndefined()
    expect(cleared.position_id).toBeUndefined()
    expect(cleared.note).toBe('换个说法')
    expect(cleared.title).toBe('A2')

    const scheduled = h.work.schedule(t.id, { start: T0, end: plusMs(T0, 3_600_000) })
    expect(scheduled.horizon).toBe('today')
    expect(h.work.schedule(t.id, null).scheduled).toBeUndefined()
    // 手动改 horizon
    expect(h.work.updateTodo(t.id, { horizon: 'week' }).horizon).toBe('week')
    // 重挂目标 / 岗位
    const re = h.work.updateTodo(t.id, { goal_id: 'goal_2', position_id: 'asg_2' })
    expect(re).toMatchObject({ goal_id: 'goal_2', position_id: 'asg_2' })
  })

  it('打勾 / 关闭：落 closed_at，重开时清掉；有事项的记时间线', () => {
    const m = h.work.createMatter({ kind: 'project', title: 'P' })
    const t = h.work.createTodo({ title: 'A', owner: 'per_1', matter_id: m.id })
    const done = h.work.complete(t.id)
    expect(done.status).toBe('done')
    expect(done.closed_at).toBe(T0)
    const reopened = h.work.updateTodo(t.id, { status: 'open' })
    expect(reopened.closed_at).toBeUndefined()
    expect(h.work.drop(t.id).status).toBe('dropped')
    const kinds = h.work.matterView(m.id).timeline.filter((e) => e.kind === 'todo')
    expect(kinds).toHaveLength(4) // 建 + done + open + dropped
    // 状态没变就不再记一条
    h.work.updateTodo(t.id, { title: 'A3' })
    expect(h.work.matterView(m.id).timeline.filter((e) => e.kind === 'todo')).toHaveLength(4)
  })

  it('长期拆短期：父子，子项继承目标 / 岗位 / 事项', () => {
    const m = h.work.createMatter({ kind: 'project', title: 'P' })
    const parent = h.work.createTodo({
      title: 'Q4 前上线新品页',
      owner: 'per_1',
      goal_id: 'goal_1',
      position_id: 'asg_1',
      matter_id: m.id,
    })
    const { children } = h.work.splitTodo(parent.id, [
      { title: '写文案' },
      { title: '做图', due: plusMs(T0, 2 * DAY_MS) },
    ])
    expect(children).toHaveLength(2)
    expect(children[0]).toMatchObject({
      parent_id: parent.id,
      goal_id: 'goal_1',
      position_id: 'asg_1',
      matter_id: m.id,
      source: 'plan',
      horizon: 'backlog',
    })
    expect(children[1]?.horizon).toBe('week')
    expect(h.work.listTodos({ parent_id: parent.id })).toHaveLength(2)
    expect(() => h.work.splitTodo(parent.id, [])).toThrowError(/至少要给一条/)
  })

  it('没有事项 / 目标的父项拆出来的子项也不带这些字段', () => {
    const parent = h.work.createTodo({ title: '买咖啡', owner: 'per_1' })
    const { children } = h.work.splitTodo(parent.id, [{ title: '先看看哪家' }])
    expect(children[0]?.goal_id).toBeUndefined()
    expect(children[0]?.matter_id).toBeUndefined()
  })
})

describe('委托与卡片回填（37 §2.2 交点一）', () => {
  let h: Harness
  beforeEach(() => {
    h = make()
  })

  it('委托 = 起 Run，状态转 doing，事项时间线留痕', async () => {
    const m = h.work.createMatter({ kind: 'conversation', title: 'Anna' })
    const t = h.work.createTodo({ title: '回 Anna', owner: 'per_1', matter_id: m.id })
    const delegated = await h.work.delegate(t.id, {
      assignment_id: 'asg_1',
      brief: '按窗口内流程走',
      by: 'per_1',
    })
    expect(delegated.status).toBe('doing')
    expect(delegated.delegate).toMatchObject({
      assignment_id: 'asg_1',
      brief: '按窗口内流程走',
      state: 'running',
      run_id: 'run_1',
    })
    expect(delegated.runs).toEqual(['run_1'])
    expect(h.runs[0]?.todo_id).toBe(t.id)
  })

  it('没有事项的待办委托时现开一个 adhoc 事项——上下文必须有家', async () => {
    const t = h.work.createTodo({ title: '查一下竞品价', owner: 'per_1', position_id: 'asg_1' })
    const delegated = await h.work.delegate(t.id, { assignment_id: 'asg_1', by: 'per_1' })
    expect(delegated.matter_id).toBeDefined()
    const matter = h.work.requireMatter(delegated.matter_id as string)
    expect(matter.kind).toBe('adhoc')
    expect(matter.position_id).toBe('asg_1')
    // brief 缺省用 note / title
    expect(h.runs[0]?.brief).toBe('查一下竞品价')
  })

  it('没装运行时的进程委托会被拒（not_implemented）', async () => {
    const bare = make({ startRun: false })
    const t = bare.work.createTodo({ title: 'x', owner: 'per_1' })
    await expect(bare.work.delegate(t.id, { assignment_id: 'asg_1', by: 'per_1' })).rejects.toThrow(
      /没有装配运行时/,
    )
  })

  it('撤销委托：状态回 open；没委托过的原样返回', async () => {
    const t = h.work.createTodo({ title: 'x', owner: 'per_1' })
    expect(h.work.undelegate(t.id).delegate).toBeUndefined()
    await h.work.delegate(t.id, { assignment_id: 'asg_1', by: 'per_1' })
    const back = h.work.undelegate(t.id)
    expect(back.delegate?.state).toBe('cancelled')
    expect(back.status).toBe('open')
    // 已完成的不因为撤销委托被拉回 open
    h.work.complete(t.id)
    expect(h.work.undelegate(t.id).status).toBe('done')
  })

  it('卡片回填：按 todo_id 精确挂；重复不叠加', async () => {
    const m = h.work.createMatter({ kind: 'conversation', title: 'Anna' })
    const t = h.work.createTodo({ title: '回 Anna', owner: 'per_1', matter_id: m.id })
    const ref = cardRefOf(
      approval({
        subject: { object: { type: 'thread', id: 'thr_1' }, matter_id: m.id, todo_id: t.id },
      }),
    )
    const first = h.work.onCard(ref)
    expect(first.todo?.cards).toEqual(['apr_1'])
    expect(first.matter?.id).toBe(m.id)
    h.work.onCard(ref)
    expect(h.work.requireTodo(t.id).cards).toEqual(['apr_1'])
    expect(h.work.matterView(m.id).open_card_ids).toEqual(['apr_1'])
  })

  it('卡片回填：没有 todo_id 时按 run_id 在同一事项里找', async () => {
    const m = h.work.createMatter({ kind: 'conversation', title: 'Anna' })
    const t = h.work.createTodo({ title: '回 Anna', owner: 'per_1', matter_id: m.id })
    await h.work.delegate(t.id, { assignment_id: 'asg_1', by: 'per_1' })
    const { todo: hit } = h.work.onCard(
      cardRefOf(
        approval({
          subject: { object: { type: 'thread', id: 'thr_1' }, matter_id: m.id },
          evidence: { run_id: 'run_1', source_events: [], provenance: { seen: [] }, precheck: {} },
        }),
      ),
    )
    expect(hit?.id).toBe(t.id)
    expect(hit?.cards).toEqual(['apr_1'])
  })

  it('卡片回填：对不上待办就只记事项时间线；连事项都没有就什么都不做', () => {
    const m = h.work.createMatter({ kind: 'conversation', title: 'Anna' })
    const only = h.work.onCard(
      cardRefOf(approval({ subject: { object: { type: 'thread', id: 't' }, matter_id: m.id } })),
    )
    expect(only.todo).toBeUndefined()
    expect(h.work.matterView(m.id).timeline.map((e) => e.kind)).toEqual(['card'])

    expect(h.work.onCard(cardRefOf(approval()))).toEqual({})
    // 事项 id 存在字段里但库里没有 → 也不炸
    expect(
      h.work.onCard(
        cardRefOf(approval({ subject: { object: { type: 't', id: 't' }, matter_id: 'mat_gone' } })),
      ),
    ).toEqual({})
  })

  it('cardRefOf 认旧字段 work_item_id（正名前的别名）', () => {
    const ref = cardRefOf(
      approval({ subject: { object: { type: 'thread', id: 't' }, work_item_id: 'mat_old' } }),
    )
    expect(ref.matter_id).toBe('mat_old')
  })

  it('运行结束：更新摘要 + 把这条 run 的委托标成 done', async () => {
    const m = h.work.createMatter({ kind: 'conversation', title: 'Anna' })
    const t = h.work.createTodo({ title: '回 Anna', owner: 'per_1', matter_id: m.id })
    const other = h.work.createTodo({ title: '别的', owner: 'per_1', matter_id: m.id })
    await h.work.delegate(t.id, { assignment_id: 'asg_1', by: 'per_1' })
    const matter = h.work.onRunCompleted({
      matter_id: m.id,
      run_id: 'run_1',
      summary: '草稿已提交，等你批',
      session_ref: { runtime: 'direct', session_id: 'ses_1' },
    })
    expect(matter.context.summary).toBe('草稿已提交，等你批')
    expect(h.work.requireTodo(t.id).delegate?.state).toBe('done')
    expect(h.work.requireTodo(other.id).delegate).toBeUndefined()
  })
})

describe('目标 / 日历 / 计划 / 复盘', () => {
  let h: Harness
  beforeEach(() => {
    h = make()
  })

  it('目标：建、列、算进度', () => {
    const company = h.work.createGoal({
      level: 'company',
      title: '本月销售额 10 万',
      owner: 'per_1',
      metric: { query: 'sales.total', format: 'money' },
      target: 100000,
      period: { kind: 'month', start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
    })
    const position = h.work.createGoal({
      level: 'position',
      title: '本月订单 500 单',
      owner: 'per_1',
      parent_id: company.id,
      position_id: 'asg_1',
      metric: { query: 'orders.count', format: 'count' },
      target: 500,
      period: { kind: 'month', start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
      status: 'active',
    })
    expect(h.work.getGoal(company.id)?.level).toBe('company')
    expect(h.work.listGoals({ level: 'position' }).map((g) => g.id)).toEqual([position.id])
    const progress = h.work.progress((g) => ({ value: g.target / 2 }))
    expect(progress).toHaveLength(2)
    expect(progress[0]?.progress_pct).toBe(50)
    expect(h.work.progressOf(company.id, () => ({ value: 0 })).progress_pct).toBe(0)
    expect(() => h.work.progressOf('nope', () => undefined)).toThrowError(/没有这个目标/)
  })

  it('日历：只看本人的未完待办，合上会议 / 定时 / 卡片到期', () => {
    h.work.createTodo({
      title: 'A',
      owner: 'per_1',
      scheduled: { start: T0, end: plusMs(T0, 3_600_000) },
    })
    h.work.createTodo({ title: 'B', owner: 'per_2', due: T0 })
    const range = h.work.todayRange()
    expect(range.from).toBe('2026-09-08T16:00:00.000Z')
    const mine = h.work.calendar(range, { person_id: 'per_1' })
    expect(mine.map((i) => i.title)).toEqual(['A'])
    const all = h.work.calendar(range, {}, { cards: [approval({ expires_at: T0 })] })
    expect(all.map((i) => i.source)).toEqual(['todo', 'card_due', 'todo'])
    const withMeeting = h.work.calendar(
      range,
      { person_id: 'per_1' },
      {
        meetings: [
          {
            id: 'cal_m',
            source: 'meeting',
            title: '周会',
            start: plusMs(T0, 7_200_000),
            end: plusMs(T0, 10_800_000),
            all_day: false,
            ref: { type: 'meeting', id: 'm' },
          },
        ],
        tasks: [{ id: 'sch_1', state: 'active', next_fire_at: plusMs(T0, 3_600_000) }],
      },
    )
    expect(withMeeting.map((i) => i.source)).toEqual(['todo', 'scheduled_task', 'meeting'])
  })

  it('今天按工作区时区切；有运行时才给「交给 Agent」的建议', async () => {
    expect(h.work.todayDate()).toBe('2026-09-09')
    const m = h.work.createMatter({ kind: 'project', title: 'P' })
    h.work.createTodo({
      title: '有事项的本周待办',
      owner: 'per_1',
      matter_id: m.id,
      due: plusMs(T0, 3 * DAY_MS),
    })
    const withRuntime = h.work.todayPlan({
      person_id: 'per_1',
      goals: [],
      delegate_to: 'asg_1',
    })
    expect(withRuntime.suggestions.some((s) => s.kind === 'delegate')).toBe(true)

    const bare = make({ startRun: false })
    bare.work.createTodo({
      title: '有事项的本周待办',
      owner: 'per_1',
      due: plusMs(T0, 3 * DAY_MS),
    })
    const noRuntime = bare.work.todayPlan({
      person_id: 'per_1',
      goals: [],
      delegate_to: 'asg_1',
    })
    expect(noRuntime.suggestions.some((s) => s.kind === 'delegate')).toBe(false)
  })

  it('今天的计划：一天一条，不重复问；refresh 才重拟', () => {
    h.work.createTodo({ title: '老待办', owner: 'per_1' })
    const first = h.work.todayPlan({ person_id: 'per_1', goals: [] })
    expect(first.state).toBe('drafted')
    expect(first.suggestions).toHaveLength(1)
    const again = h.work.todayPlan({ person_id: 'per_1', goals: [] })
    expect(again.id).toBe(first.id)
    h.work.createTodo({ title: '新待办', owner: 'per_1' })
    const refreshed = h.work.todayPlan({ person_id: 'per_1', goals: [], refresh: true })
    expect(refreshed.id).toBe(first.id)
    expect(refreshed.created_at).toBe(first.created_at)
    expect(h.work.getPlan(first.id)?.state).toBe('drafted')
  })

  it('计划会带上昨天的复盘与审批项 id', () => {
    const draft = h.work.todayPlan({ person_id: 'per_1', goals: [] })
    const linked = h.work.linkPlanApproval(draft.id, 'apr_plan')
    expect(linked.approval_item_id).toBe('apr_plan')
    h.work.saveReview({
      person_id: 'per_1',
      period: { kind: 'day', start: T0, end: T0 },
      goals: [],
      cards: { ai_handled: 0, you_handled: 0, auto_sent: 0, blocked: 0 },
      todos: { done: 0, total: 0, completion_pct: 100 },
      meetings: { count: 0, outputs: 0 },
      lessons: [],
      highlights: [],
      next_plan_draft: {
        date: '2026-09-09',
        person_id: 'per_1',
        basis: { goals: [], meetings: 0, due_todos: 0, cards_waiting: 0 },
        suggestions: [],
        options: [],
      },
    })
    const again = h.work.todayPlan({ person_id: 'per_1', goals: [], refresh: true })
    expect(again.basis.yesterday_review_id).toBeDefined()
    expect(again.approval_item_id).toBe('apr_plan')
    expect(() => h.work.linkPlanApproval('nope', 'x')).toThrowError(/没有这个每日计划/)
  })

  it('采纳才写待办：promote / schedule / delegate / create 四种建议各走一遍', async () => {
    const m = h.work.createMatter({ kind: 'project', title: 'P' })
    const promote = h.work.createTodo({ title: '挑到今天', owner: 'per_1' })
    const scheduleTarget = h.work.createTodo({ title: '排时段', owner: 'per_1' })
    const delegateTarget = h.work.createTodo({ title: '交给 AI', owner: 'per_1', matter_id: m.id })
    const plan = h.work.todayPlan({ person_id: 'per_1', goals: [] })
    const custom = {
      ...plan,
      suggestions: [
        {
          id: 's1',
          kind: 'promote' as const,
          title: '挑到今天',
          reason: 'r',
          todo_id: promote.id,
          selected: true,
        },
        {
          id: 's2',
          kind: 'schedule' as const,
          title: '排时段',
          reason: 'r',
          todo_id: scheduleTarget.id,
          scheduled: { start: T0, end: plusMs(T0, 3_600_000) },
          selected: true,
        },
        {
          id: 's3',
          kind: 'delegate' as const,
          title: '交给 AI',
          reason: 'r',
          todo_id: delegateTarget.id,
          assignment_id: 'asg_1',
          brief: '照旧',
          selected: true,
        },
        { id: 's4', kind: 'create' as const, title: '新建一条', reason: 'r', selected: true },
        {
          id: 's5',
          kind: 'promote' as const,
          title: '没勾的',
          reason: 'r',
          todo_id: promote.id,
          selected: false,
        },
      ],
    }
    h.work.store.putPlan(custom)
    const { plan: adopted, todos } = await h.work.adoptPlan(custom.id, { by: 'per_1' })
    expect(adopted.state).toBe('adopted')
    expect(todos).toHaveLength(4)
    expect(h.work.requireTodo(promote.id).horizon).toBe('today')
    expect(h.work.requireTodo(scheduleTarget.id).scheduled?.start).toBe(T0)
    expect(h.work.requireTodo(delegateTarget.id).delegate?.assignment_id).toBe('asg_1')
    expect(todos[3]?.title).toBe('新建一条')
    expect(todos[3]?.source).toBe('plan')
  })

  it('「调整」= 传勾选清单；采纳时跳过对不上的建议', async () => {
    const plan = h.work.todayPlan({ person_id: 'per_1', goals: [] })
    const custom = {
      ...plan,
      suggestions: [
        {
          id: 'a',
          kind: 'promote' as const,
          title: 'A',
          reason: 'r',
          todo_id: 'gone',
          selected: true,
        },
        {
          id: 'b',
          kind: 'schedule' as const,
          title: 'B',
          reason: 'r',
          todo_id: 'gone2',
          selected: true,
        },
        {
          id: 'c',
          kind: 'create' as const,
          title: 'C',
          reason: 'r',
          goal_id: 'goal_1',
          matter_id: undefined,
          selected: false,
        },
      ],
    }
    h.work.store.putPlan(custom)
    const { plan: adjusted, todos } = await h.work.adoptPlan(custom.id, {
      by: 'per_1',
      selected_ids: ['a', 'c'],
    })
    expect(adjusted.state).toBe('adjusted')
    expect(todos.map((t) => t.title)).toEqual(['C'])
  })

  it('建议不完整时安静跳过：schedule 缺时段、delegate 缺岗位 / 缺运行时', async () => {
    const bare = make({ startRun: false })
    const target = bare.work.createTodo({ title: 'A', owner: 'per_1' })
    const plan = bare.work.todayPlan({ person_id: 'per_1', goals: [] })
    bare.work.store.putPlan({
      ...plan,
      suggestions: [
        { id: 'a', kind: 'schedule', title: 'A', reason: 'r', todo_id: target.id, selected: true },
        {
          id: 'b',
          kind: 'delegate',
          title: 'A',
          reason: 'r',
          todo_id: target.id,
          assignment_id: 'asg_1',
          selected: true,
        },
        { id: 'c', kind: 'delegate', title: 'A', reason: 'r', todo_id: target.id, selected: true },
      ],
    })
    const { todos } = await bare.work.adoptPlan(plan.id, { by: 'per_1' })
    expect(todos).toEqual([])
  })

  it('稍后：什么都不写', async () => {
    const plan = h.work.todayPlan({ person_id: 'per_1', goals: [] })
    expect(h.work.deferPlan(plan.id).state).toBe('later')
    expect(() => h.work.deferPlan('nope')).toThrowError(/没有这个每日计划/)
    await expect(h.work.adoptPlan('nope')).rejects.toThrow(/没有这个每日计划/)
  })

  it('复盘：存下来能按人 / 周期查，最新的在前', () => {
    const draft = {
      person_id: 'per_1',
      period: { kind: 'day' as const, start: T0, end: T0 },
      goals: [],
      cards: { ai_handled: 1, you_handled: 2, auto_sent: 0, blocked: 0 },
      todos: { done: 1, total: 2, completion_pct: 50 },
      meetings: { count: 0, outputs: 0 },
      lessons: [],
      highlights: [],
      next_plan_draft: {
        date: '2026-09-10',
        person_id: 'per_1',
        basis: { goals: [], meetings: 0, due_todos: 0, cards_waiting: 0 },
        suggestions: [],
        options: [],
      },
    }
    const first = h.work.saveReview(draft, 'apr_rev')
    expect(first.approval_item_id).toBe('apr_rev')
    h.clock.advance(1000)
    h.work.saveReview(draft)
    expect(h.work.listReviews({ person_id: 'per_1' })).toHaveLength(2)
    expect(h.work.latestReview('per_1')?.approval_item_id).toBeUndefined()
    expect(h.work.latestReview('per_2')).toBeUndefined()
  })
})

describe('装配', () => {
  it('不给 store 就是内存档；不给 random 也能生成唯一 id；默认时区 +8', () => {
    const work = new Work({ workspace_id: 'ws_1', clock: new FakeClock() })
    expect(work.tz_offset_minutes).toBe(480)
    expect(work.now()).toBe(T0)
    const a = work.createMatter({ kind: 'adhoc', title: 'A' })
    const b = work.createMatter({ kind: 'adhoc', title: 'B' })
    expect(a.id).not.toBe(b.id)
  })

  it('可以换成 SQLite 档，行为一样', () => {
    const store = new SqliteWorkStore()
    const work = createWork({ workspace_id: 'ws_1', clock: new FakeClock(), store })
    const m = work.createMatter({ kind: 'adhoc', title: 'A' })
    work.createTodo({ title: 'T', owner: 'per_1', matter_id: m.id })
    expect(work.matterView(m.id).todos).toHaveLength(1)
    store.close()
  })

  it('startRun 可以是异步的', async () => {
    const startRun = vi.fn(async () => ({ run_id: 'run_async' }))
    const work = createWork({ workspace_id: 'ws_1', clock: new FakeClock(), startRun })
    const m = work.createMatter({ kind: 'adhoc', title: 'A' })
    const { run_id } = await work.say(m.id, {
      person_id: 'per_1',
      assignment_id: 'asg_1',
      text: 'hi',
    })
    expect(run_id).toBe('run_async')
    expect(startRun).toHaveBeenCalledOnce()
  })
})
