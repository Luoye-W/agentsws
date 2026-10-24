/**
 * WP508：只有确认含义的卡不出通用的「修改」（`instruct`）。
 * int/1039 实拍：AI 提议停用知识那张卡上是「停用 2 条 / 修改 / 不用 / 稍后」——「修改」对这张卡没意义。
 */
import { describe, expect, it } from 'vitest'
import type { ProjectContext } from '../src/index.js'
import { CONFIRM_ONLY_FORMS, projectCard, resolveDecision } from '../src/index.js'
import { item, NOW } from './fixtures.js'

const ctx: ProjectContext = { now: NOW, position_id: 'asg_1' }

const knowledge = (payload: Record<string, unknown>) =>
  item({ kind: 'knowledge_update', payload: { before: null, after: 'x', ...payload } })

describe('WP508 只有确认含义的卡：没有「修改」', () => {
  it('停用 / 启用知识卡、FAQ 整批、助理拆出来的那一批、可能过期：只剩 批 / 不要 / 稍后 / 打开', () => {
    for (const form of ['knowledge_toggle', 'faq_batch', 'assistant_notes', 'knowledge_stale']) {
      expect(CONFIRM_ONLY_FORMS.has(form)).toBe(true)
      const card = projectCard(knowledge({ form }), ctx)
      expect(card.available_actions, form).toEqual(['approve', 'reject', 'snooze', 'open'])
      expect(card.action_labels?.instruct, form).toBeUndefined()
    }
  })

  it('普通的知识卡（一条事实）、「学到 N 条」照旧有「修改」', () => {
    for (const payload of [{}, { form: 'knowledge_learned' }]) {
      expect(projectCard(knowledge(payload), ctx).available_actions).toContain('instruct')
    }
  })

  it('卡上没有的动作服务端也不收：对停用卡点「修改」被拒', () => {
    const card = projectCard(knowledge({ form: 'knowledge_toggle' }), ctx)
    expect(() =>
      resolveDecision(
        card,
        { action: 'instruct', instruction: { text: '换一条', scope: 'single_reply' } } as never,
        { now: NOW },
      ),
    ).toThrow(/不能「instruct」/)
  })
})
