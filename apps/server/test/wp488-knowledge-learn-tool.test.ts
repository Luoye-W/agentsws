/**
 * WP488：客服岗位「学一遍」工具的执行器——只给客服；没接邮箱回连接码（运行就地出连接卡）；开跑回进度。
 */
import { describe, expect, it } from 'vitest'
import type { KnowledgeLearner } from '../src/knowledge-learn.js'
import { createKnowledgeLearnToolExecutor } from '../src/knowledge-learn-tools.js'

const req = (role_id: string) =>
  ({
    id: 'run_1',
    workspace_id: 'ws_1',
    actor: { person_id: 'p_1', assignment_id: 'asg_1', role_id },
  }) as never

describe('learn_support_knowledge', () => {
  const started: unknown[] = []
  const learner = {
    start: async (_a: unknown, input: unknown) => {
      started.push(input)
      return {
        id: 'klj_1',
        state: 'running',
        source: 'website',
        urls: ['https://help.x.test/'],
        matter_id: 'mat_1',
      }
    },
  } as unknown as KnowledgeLearner
  const exec = (connected: boolean) =>
    createKnowledgeLearnToolExecutor({
      learner: () => learner,
      mailConnected: async () => connected,
    })

  it('不是客服职责：拦下', async () => {
    const out = await exec(true)({
      name: 'learn_support_knowledge',
      input: { source: 'email' },
      request: req('dtc.seo'),
    } as never)
    expect(out.status).toBe('blocked')
  })

  it('没接邮箱：回 needs_connection:imap_smtp（运行就地出连接卡），不开空事', async () => {
    const out = await exec(false)({
      name: 'learn_support_knowledge',
      input: { source: 'email' },
      request: req('dtc.support'),
    } as never)
    expect(out.status).toBe('error')
    expect((out as { reason: string }).reason).toMatch(/^needs_connection:imap_smtp/)
    expect(started).toHaveLength(0)
  })

  it('售后站一句话给：开一次网站学', async () => {
    const out = await exec(false)({
      name: 'learn_support_knowledge',
      input: { source: 'website', urls: ['help.x.test'] },
      request: req('dtc.support'),
    } as never)
    expect(out.status).toBe('ok')
    expect(started).toEqual([{ source: 'website', urls: ['help.x.test'] }])
    expect((out as { data: { matter_id: string } }).data.matter_id).toBe('mat_1')
  })
})
