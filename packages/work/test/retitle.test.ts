/**
 * WP264（决策 177 / 184）：事项短标题——AI 起的、退路、人改过的不再被自动覆盖；
 * 时间线新三格（运行摘要、下一步建议、预览的改动与检查）照存照取。
 */
import { describe, expect, it } from 'vitest'
import { createWork } from '../src/service.js'
import { SqliteWorkStore } from '../src/sqlite-store.js'
import { FakeClock, seeded } from './helpers.js'

const make = (sqlite = false) =>
  createWork({
    workspace_id: 'ws_1',
    clock: new FakeClock(),
    random: seeded(3),
    ...(sqlite ? { store: new SqliteWorkStore({ path: ':memory:' }) } : {}),
  })

describe('WP264 retitle', () => {
  it('AI 起的标题落进去，记 title_source = ai', () => {
    const work = make()
    const m = work.createMatter({
      kind: 'adhoc',
      title: '用 agentsws-theme 给 Rollout 搭英文首页…',
    })
    const next = work.retitle(m.id, '  Rollout 英文首页 ·  深色科技风 ', 'ai')
    expect(next.title).toBe('Rollout 英文首页 · 深色科技风')
    expect(next.title_source).toBe('ai')
    expect(work.getMatter(m.id)?.title).toBe('Rollout 英文首页 · 深色科技风')
  })

  it('人改过的不被 AI / 退路覆盖；人还能再改', () => {
    const work = make()
    const m = work.createMatter({ kind: 'adhoc', title: '原话' })
    work.retitle(m.id, '我自己起的', 'user')
    expect(work.retitle(m.id, 'AI 的', 'ai').title).toBe('我自己起的')
    expect(work.retitle(m.id, '原话前 20 字…', 'brief').title_source).toBe('user')
    expect(work.retitle(m.id, '再改一次', 'user').title).toBe('再改一次')
  })

  it('空白标题不收', () => {
    const work = make()
    const m = work.createMatter({ kind: 'adhoc', title: '原话' })
    expect(() => work.retitle(m.id, '   ', 'user')).toThrow(/空/)
  })

  it.each([false, true])('时间线新三格照存照取（sqlite=%s）', (sqlite) => {
    const work = make(sqlite)
    const m = work.createMatter({ kind: 'adhoc', title: 't' })
    work.appendEvent(m.id, {
      kind: 'run',
      text: '跑完了',
      actor: { kind: 'agent', id: 'asg_1' },
      run_id: 'run_1',
      run_digest: {
        seconds: 252,
        outcome: 'completed',
        steps: [{ text: '读 a', status: 'ok', seconds: 2 }],
      },
    })
    work.appendEvent(m.id, {
      kind: 'agent_message',
      text: '预览好了',
      actor: { kind: 'agent', id: 'asg_1' },
      next_suggestion: '发布上线',
    })
    work.appendEvent(m.id, {
      kind: 'status',
      text: '预览好了',
      actor: { kind: 'agent', id: 'site' },
      preview: {
        url: 'https://example.myshopify.com/?preview_theme_id=1',
        label: 'v1',
        theme_id: '1',
        changed_files: ['templates/index.json'],
        check: { errors: 0, warnings: 0 },
      },
    })
    const [a, b, c] = work.store.listMatterEvents(m.id)
    expect(a?.run_digest?.steps[0]?.text).toBe('读 a')
    expect(b?.next_suggestion).toBe('发布上线')
    expect(c?.preview?.changed_files).toEqual(['templates/index.json'])
    expect(c?.preview?.check).toEqual({ errors: 0, warnings: 0 })
  })
})
