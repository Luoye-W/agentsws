/**
 * `WorkStore` 的**契约一致性套件**：接受任意实现，对内存档与 SQLite 档各跑一遍。
 * 两档之间的任何漂移都应该在这里露出来——换存储不该改行为。
 */
import type { WorkStore } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { goal, matter, matterEvent, plan, review, T0, todo } from './helpers.js'

export interface StoreHarness {
  name: string
  /** 每个用例一份全新实例。 */
  make(): WorkStore
  /** 用例结束后释放（SQLite 档关库）。 */
  dispose?(store: WorkStore): void
}

const at = (offsetMinutes: number): string =>
  new Date(Date.parse(T0) + offsetMinutes * 60_000).toISOString()

export function runWorkStoreConformance(h: StoreHarness): void {
  const withStore = (fn: (s: WorkStore) => void): void => {
    const store = h.make()
    try {
      fn(store)
    } finally {
      h.dispose?.(store)
    }
  }

  describe(`WorkStore 一致性 · ${h.name}`, () => {
    it('事项：写、读、按工作区 / 类型 / 状态 / 目标 / 参与者筛', () => {
      withStore((s) => {
        s.putMatter(matter())
        s.putMatter(
          matter({
            id: 'mat_2',
            kind: 'project',
            status: 'closed',
            goal_id: 'goal_1',
            position_id: 'asg_1',
            context: {
              summary: '',
              pinned: [],
              participants: ['per_2'],
              last_activity: at(10),
            },
          }),
        )
        s.putMatter(matter({ id: 'mat_x', workspace_id: 'ws_other' }))

        expect(s.getMatter('mat_1')?.title).toBe('Anna 的退货请求')
        expect(s.getMatter('nope')).toBeUndefined()
        expect(s.listMatters({ workspace_id: 'ws_1' }).map((m) => m.id)).toEqual(['mat_2', 'mat_1'])
        expect(s.listMatters({ workspace_id: 'ws_1', kind: 'project' }).map((m) => m.id)).toEqual([
          'mat_2',
        ])
        expect(s.listMatters({ workspace_id: 'ws_1', status: ['open'] }).map((m) => m.id)).toEqual([
          'mat_1',
        ])
        expect(s.listMatters({ workspace_id: 'ws_1', goal_id: 'goal_1' }).map((m) => m.id)).toEqual(
          ['mat_2'],
        )
        expect(
          s.listMatters({ workspace_id: 'ws_1', position_id: 'asg_1' }).map((m) => m.id),
        ).toEqual(['mat_2'])
        expect(
          s.listMatters({ workspace_id: 'ws_1', participant: 'per_1' }).map((m) => m.id),
        ).toEqual(['mat_1'])
        expect(s.listMatters({ workspace_id: 'ws_1', limit: 1 }).map((m) => m.id)).toEqual([
          'mat_2',
        ])
        expect(s.listMatters({ workspace_id: 'ws_other' })).toHaveLength(1)
      })
    })

    it('事项：更新同一个 id 覆盖，不新增一行', () => {
      withStore((s) => {
        s.putMatter(matter())
        s.putMatter(matter({ title: '改过的标题', status: 'waiting' }))
        expect(s.listMatters({ workspace_id: 'ws_1' })).toHaveLength(1)
        expect(s.getMatter('mat_1')?.title).toBe('改过的标题')
      })
    })

    it('时间线：按时间升序、limit 取最近 N 条、before 往前翻、计数', () => {
      withStore((s) => {
        s.putMatter(matter())
        for (let i = 0; i < 5; i += 1) {
          s.appendMatterEvent(matterEvent({ id: `mev_${i}`, at: at(i), text: `第 ${i} 条` }))
        }
        expect(s.countMatterEvents('mat_1')).toBe(5)
        expect(s.listMatterEvents('mat_1').map((e) => e.id)).toEqual([
          'mev_0',
          'mev_1',
          'mev_2',
          'mev_3',
          'mev_4',
        ])
        expect(s.listMatterEvents('mat_1', { limit: 2 }).map((e) => e.id)).toEqual([
          'mev_3',
          'mev_4',
        ])
        expect(s.listMatterEvents('mat_1', { before: at(2) }).map((e) => e.id)).toEqual([
          'mev_0',
          'mev_1',
        ])
        expect(s.listMatterEvents('mat_1', { before: at(4), limit: 1 }).map((e) => e.id)).toEqual([
          'mev_3',
        ])
        expect(s.listMatterEvents('mat_none')).toEqual([])
        expect(s.countMatterEvents('mat_none')).toBe(0)
      })
    })

    it('目标：按 level / position / owner / parent / status 筛，创建序返回', () => {
      withStore((s) => {
        s.putGoal(goal())
        s.putGoal(
          goal({
            id: 'goal_2',
            level: 'position',
            parent_id: 'goal_1',
            position_id: 'asg_1',
            owner: 'per_2',
            status: 'archived',
            created_at: at(1),
          }),
        )
        s.putGoal(goal({ id: 'goal_x', workspace_id: 'ws_other' }))
        expect(s.getGoal('goal_1')?.target).toBe(100000)
        expect(s.getGoal('nope')).toBeUndefined()
        expect(s.listGoals({ workspace_id: 'ws_1' }).map((g) => g.id)).toEqual(['goal_1', 'goal_2'])
        expect(s.listGoals({ workspace_id: 'ws_1', level: 'position' }).map((g) => g.id)).toEqual([
          'goal_2',
        ])
        expect(
          s.listGoals({ workspace_id: 'ws_1', position_id: 'asg_1' }).map((g) => g.id),
        ).toEqual(['goal_2'])
        expect(s.listGoals({ workspace_id: 'ws_1', owner: 'per_2' }).map((g) => g.id)).toEqual([
          'goal_2',
        ])
        expect(s.listGoals({ workspace_id: 'ws_1', parent_id: 'goal_1' }).map((g) => g.id)).toEqual(
          ['goal_2'],
        )
        expect(s.listGoals({ workspace_id: 'ws_1', status: ['active'] }).map((g) => g.id)).toEqual([
          'goal_1',
        ])
      })
    })

    it('待办：全部筛选维度 + 时间窗口 + scheduled_only + limit', () => {
      withStore((s) => {
        s.putTodo(todo())
        s.putTodo(
          todo({
            id: 'td_2',
            owner: 'per_2',
            position_id: 'asg_1',
            matter_id: 'mat_1',
            goal_id: 'goal_1',
            parent_id: 'td_1',
            horizon: 'today',
            status: 'done',
            due: at(60),
            created_at: at(1),
          }),
        )
        s.putTodo(
          todo({
            id: 'td_3',
            horizon: 'week',
            scheduled: { start: at(120), end: at(180) },
            created_at: at(2),
          }),
        )
        s.putTodo(todo({ id: 'td_x', workspace_id: 'ws_other' }))

        expect(s.getTodo('td_1')?.title).toBe('把新品页上线')
        expect(s.getTodo('nope')).toBeUndefined()
        expect(s.listTodos({ workspace_id: 'ws_1' }).map((t) => t.id)).toEqual([
          'td_1',
          'td_2',
          'td_3',
        ])
        expect(s.listTodos({ workspace_id: 'ws_1', owner: 'per_2' }).map((t) => t.id)).toEqual([
          'td_2',
        ])
        expect(
          s.listTodos({ workspace_id: 'ws_1', position_id: 'asg_1' }).map((t) => t.id),
        ).toEqual(['td_2'])
        expect(s.listTodos({ workspace_id: 'ws_1', matter_id: 'mat_1' }).map((t) => t.id)).toEqual([
          'td_2',
        ])
        expect(s.listTodos({ workspace_id: 'ws_1', goal_id: 'goal_1' }).map((t) => t.id)).toEqual([
          'td_2',
        ])
        expect(s.listTodos({ workspace_id: 'ws_1', parent_id: 'td_1' }).map((t) => t.id)).toEqual([
          'td_2',
        ])
        expect(
          s.listTodos({ workspace_id: 'ws_1', horizon: ['today', 'week'] }).map((t) => t.id),
        ).toEqual(['td_2', 'td_3'])
        expect(s.listTodos({ workspace_id: 'ws_1', status: ['open'] }).map((t) => t.id)).toEqual([
          'td_1',
          'td_3',
        ])
        expect(
          s.listTodos({ workspace_id: 'ws_1', scheduled_only: true }).map((t) => t.id),
        ).toEqual(['td_3'])
        // 时间窗口：没有 due 也没有 scheduled 的直接落选
        expect(
          s.listTodos({ workspace_id: 'ws_1', from: at(0), to: at(100) }).map((t) => t.id),
        ).toEqual(['td_2'])
        expect(s.listTodos({ workspace_id: 'ws_1', from: at(100) }).map((t) => t.id)).toEqual([
          'td_3',
        ])
        expect(s.listTodos({ workspace_id: 'ws_1', to: at(100) }).map((t) => t.id)).toEqual([
          'td_2',
        ])
        expect(s.listTodos({ workspace_id: 'ws_1', limit: 2 })).toHaveLength(2)
      })
    })

    it('每日计划：一天一条，按 (工作区, 人, 日期) 找得到', () => {
      withStore((s) => {
        s.putPlan(plan())
        s.putPlan(plan({ id: 'plan_2', date: '2026-09-10' }))
        s.putPlan(plan({ id: 'plan_3', person_id: 'per_2' }))
        expect(s.getPlan('plan_1')?.date).toBe('2026-09-09')
        expect(s.getPlan('nope')).toBeUndefined()
        expect(s.findPlan('ws_1', 'per_1', '2026-09-09')?.id).toBe('plan_1')
        expect(s.findPlan('ws_1', 'per_2', '2026-09-09')?.id).toBe('plan_3')
        expect(s.findPlan('ws_1', 'per_1', '2026-09-11')).toBeUndefined()
        expect(s.findPlan('ws_other', 'per_1', '2026-09-09')).toBeUndefined()
        // 同 id 覆盖
        s.putPlan(plan({ state: 'adopted' }))
        expect(s.getPlan('plan_1')?.state).toBe('adopted')
      })
    })

    it('复盘：按人 / 周期筛，最新的在前，limit 生效', () => {
      withStore((s) => {
        s.putReview(review())
        s.putReview(
          review({ id: 'rev_2', created_at: at(10), period: { kind: 'week', start: T0, end: T0 } }),
        )
        s.putReview(review({ id: 'rev_3', person_id: 'per_2', created_at: at(20) }))
        s.putReview(review({ id: 'rev_x', workspace_id: 'ws_other' }))
        expect(s.getReview('rev_1')?.person_id).toBe('per_1')
        expect(s.getReview('nope')).toBeUndefined()
        expect(s.listReviews({ workspace_id: 'ws_1' }).map((r) => r.id)).toEqual([
          'rev_3',
          'rev_2',
          'rev_1',
        ])
        expect(
          s.listReviews({ workspace_id: 'ws_1', person_id: 'per_1' }).map((r) => r.id),
        ).toEqual(['rev_2', 'rev_1'])
        expect(s.listReviews({ workspace_id: 'ws_1', kind: 'day' }).map((r) => r.id)).toEqual([
          'rev_3',
          'rev_1',
        ])
        expect(s.listReviews({ workspace_id: 'ws_1', limit: 1 }).map((r) => r.id)).toEqual([
          'rev_3',
        ])
      })
    })

    it('存进去的是副本：改返回值不影响库里的东西', () => {
      withStore((s) => {
        const m = matter()
        s.putMatter(m)
        m.title = '外面改的'
        expect(s.getMatter('mat_1')?.title).toBe('Anna 的退货请求')
        const read = s.getMatter('mat_1')
        if (read !== undefined) read.title = '再改一次'
        expect(s.getMatter('mat_1')?.title).toBe('Anna 的退货请求')

        const t = todo()
        s.putTodo(t)
        t.cards.push('apr_x')
        expect(s.getTodo('td_1')?.cards).toEqual([])

        const g = goal()
        s.putGoal(g)
        g.target = 1
        expect(s.getGoal('goal_1')?.target).toBe(100000)

        const p = plan()
        s.putPlan(p)
        p.state = 'later'
        expect(s.getPlan('plan_1')?.state).toBe('drafted')

        const r = review()
        s.putReview(r)
        r.highlights.push('x')
        expect(s.getReview('rev_1')?.highlights).toEqual([])

        const e = matterEvent()
        s.appendMatterEvent(e)
        e.text = '改过'
        expect(s.listMatterEvents('mat_1')[0]?.text).toBe('先看一下这单')
      })
    })
  })
}
