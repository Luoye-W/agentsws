/**
 * WP488（决策 1704 = C）：运行里 `search_policies` 查政策前先让 AI 判这件事是售前还是售后——
 * 看的是这件事的来信（线程上下文），按事项缓存（key = 事项 id）；判出来的范围带进检索。
 */
import type { RunRequest } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createConnectRecordSource } from '../src/records.js'

describe('search_policies 先判售前 / 售后', () => {
  it('来信给 AI 判、按事项缓存键；没接判官就按规则', async () => {
    const searched: unknown[] = []
    const judged: [string, string][] = []
    const make = (judge: boolean) =>
      createConnectRecordSource({
        connect: {} as never,
        connections: { liveConnections: () => [] },
        clock: { now: () => '2026-10-23T00:00:00.000Z' },
        workspace_id: 'ws_1' as never,
        knowledge: {
          search: async (q) => {
            searched.push(q.stage)
            return { hits: [] }
          },
        },
        roles: { effectiveConfig: () => ({ scopes: [], ranges: [] }) },
        appendEvent: () => undefined,
        ...(judge
          ? {
              judgeStage: async (text: string, key: string) => {
                judged.push([text, key])
                return { stage: 'presales' as const }
              },
            }
          : {}),
      })
    const request = {
      id: 'run_1',
      actor: { person_id: 'p', assignment_id: 'a', role_id: 'dtc.support' },
      tools: { allow: ['search_policies'], connect_token: '', side_effect_policy: 'executor' },
      context: [{ id: 'c1', kind: 'thread', content: 'Hi, my order #10234 arrived broken.' }],
      work_item: { id: 'mat_1', conversation_id: 'c', role_id: 'dtc.support' },
    } as unknown as RunRequest
    await make(true).executeTool?.({ name: 'search_policies', input: { query: 'refund' }, request })
    expect(judged).toEqual([['Hi, my order #10234 arrived broken.', 'mat_1']])
    expect(searched).toEqual(['presales'])
    await make(false).executeTool?.({
      name: 'search_policies',
      input: { query: 'refund' },
      request,
    })
    expect(searched).toEqual(['presales', 'postsales'])
  })
})
