/**
 * WP509：stub 的红人剧本里「把红人同步到我这张飞书表 <链接>」——调一次 sync_creators_to_sheet（服务端读表头、出卡），
 * 把它回的那一句原样说出来、把卡翻成 `proposal.created`；不是这种话，红人剧本一个字节不变。
 */
import { describe, expect, it } from 'vitest'
import { createStubRuntime } from '../src/index.js'
import { kolSyncBranch } from '../src/runtime/kol.js'
import { makeRequest, runAndCollect } from './helpers.js'

const clock = { now: () => '2026-10-24T04:00:00.000Z' }
const LINK = 'https://example.feishu.cn/base/AbcDef123?table=tbl1'

describe('WP509 stub：同步到飞书表', () => {
  it('红人职责 + 有工具 + 话里有飞书表链接、说「同步到」→ 调一次；只问「同步得怎么样」→ status', async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = []
    const runtime = createStubRuntime({
      clock,
      executeTool: async (call) => {
        calls.push({ name: call.name, input: call.input as Record<string, unknown> })
        return {
          status: 'ok' as const,
          data: {
            kind: 'kol_sync_setup',
            ok: true,
            message: '读到「红人合作表」……出了一张「同步设置」卡。',
            approval_item_id: 'ap_sync',
          },
        }
      },
    })
    const { events, result } = await runAndCollect(
      runtime,
      makeRequest({
        roleId: 'kol.youtube',
        threadSubject: '同步到飞书',
        threadBody: `把红人同步到我这张飞书表 ${LINK}`,
        allow: ['sync_creators_to_sheet', 'search_creators'],
        outputs: ['answer'],
      }),
    )
    expect(calls).toEqual([
      {
        name: 'sync_creators_to_sheet',
        input: { url: LINK, instruction: expect.stringContaining('同步到') },
      },
    ])
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'proposal.created', approval_item_id: 'ap_sync' }),
    )
    const answer = result.outputs.find((o) => o.kind === 'answer')
    expect(answer?.kind === 'answer' ? answer.text : '').toContain('同步设置')

    const req = (body: string, allow = ['sync_creators_to_sheet']) =>
      makeRequest({
        roleId: 'kol.youtube',
        threadSubject: 'x',
        threadBody: body,
        allow,
        outputs: ['answer'],
      })
    expect(kolSyncBranch(req('飞书同步得怎么样了'), '飞书同步得怎么样了')).toEqual({
      tool: 'sync_creators_to_sheet',
      input: { action: 'status' },
    })
    // 不是这种话 / 没有这个工具 / 不是红人职责：不进这一岔
    expect(kolSyncBranch(req('找 20 个频道'), '找 20 个频道')).toBeUndefined()
    expect(
      kolSyncBranch(req(`同步到 ${LINK}`, ['search_creators']), `同步到 ${LINK}`),
    ).toBeUndefined()
    expect(
      kolSyncBranch(
        makeRequest({
          roleId: 'support.email',
          threadSubject: 'x',
          threadBody: 'x',
          allow: ['sync_creators_to_sheet'],
          outputs: ['answer'],
        }),
        `同步到 ${LINK}`,
      ),
    ).toBeUndefined()
  })
})
