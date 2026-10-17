/**
 * WP343：`createAssistant` 的几条规矩（不起服务进程）——快捷问题随状态变、回报只报一次、
 * 拿不准不派、`@` 只认本人名下的岗位。
 */
import type { ApprovalItem, MatterEvent, PositionInstance } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createAssistant, waitedText } from '../src/assistant.js'
import type { AssistantDispatchRow } from '../src/free-chat-store.js'

const actor = { workspace_id: 'ws_1', person_id: 'p_1', assignment_id: 'asg_owner' }
const T = '2026-10-15T08:00:00.000Z'

const position = (
  id: string,
  zh: string,
  roles: { role_id: string; role_name: string; mine?: boolean; prompt?: string }[],
  open = 0,
): PositionInstance => ({
  position_id: id,
  workspace_id: 'ws_1',
  name: { zh, en: zh },
  template_version: '1',
  holders: ['p_1'],
  roles: roles.map((r) => ({
    role_id: r.role_id,
    role_name: r.role_name,
    default: true,
    assignment_ids: ['a'],
    ...(r.mine === false ? {} : { my_assignment_id: `asg_${r.role_id}` }),
    ...(r.prompt === undefined
      ? {}
      : {
          quick_prompts: [
            {
              id: 'q',
              label: { zh: r.prompt, en: r.prompt },
              prompt: r.prompt,
              kind: 'start_task',
            },
          ],
        }),
  })),
  open_matters: open,
  pending_cards: 0,
  memory_summary: '',
})

function make(input: {
  positions: PositionInstance[]
  cards?: number
  timeline?: MatterEvent[]
  pending?: Set<string>
}) {
  const opened: { position_id: string; role_id?: string; text: string }[] = []
  const assistant = createAssistant({
    clock: { now: () => T },
    positions: async () => input.positions,
    cards: async () =>
      Array.from({ length: input.cards ?? 0 }, (_, i) => ({
        id: `c${i}`,
        title: `卡 ${i}`,
        role_id: 'dtc.support',
        created_at: '2026-10-15T05:00:00.000Z',
      })) as unknown as ApprovalItem[],
    matters: () => [],
    timeline: () => input.timeline ?? [],
    cardPending: async (_a, id) => input.pending?.has(id) ?? false,
    open: async (_a, x) => {
      opened.push(x)
      return { matter_id: `mat_${opened.length}`, title: x.text }
    },
  })
  return { assistant, opened }
}

describe('createAssistant', () => {
  it('没有岗位：快捷问题只有「帮我建一个岗位」（点了去建岗位，不发话）', async () => {
    const { assistant } = make({ positions: [] })
    const state = await assistant.state(actor)
    expect(state.suggestions).toEqual([
      { kind: 'create_position', text: '帮我建一个岗位', href: '/org?tab=positions' },
    ])
  })

  it('有卡、有岗位：今天要我处理 + 岗位今天做了什么 + 按已有岗位举例的派活句，最多 4 个', async () => {
    const { assistant } = make({
      cards: 2,
      positions: [
        position('owner', '负责人', [{ role_id: 'common.owner', role_name: '所有者' }]),
        position(
          'care',
          '客服',
          [{ role_id: 'dtc.support', role_name: '售后', prompt: '回一下今天的工单' }],
          3,
        ),
        position('ops', '网站运营', [{ role_id: 'dtc.store', role_name: '店铺管理' }], 1),
      ],
    })
    const state = await assistant.state(actor)
    expect(state.suggestions.map((s) => s.text)).toEqual([
      '今天有什么要我处理的？',
      '客服今天做了什么？',
      '网站运营今天做了什么？',
      '让客服回一下今天的工单',
    ])
  })

  it('派活：拿不准不开事项、回候选；点名了才开', async () => {
    const { assistant, opened } = make({
      positions: [
        position('care', '客服', [{ role_id: 'dtc.support', role_name: '售后' }]),
        position('ops', '网站运营', [{ role_id: 'dtc.store', role_name: '店铺管理' }]),
      ],
    })
    const unsure = await assistant.call(
      actor,
      { name: 'hand_to_position', input: { text: '帮我办了' } },
      { user_text: '帮我办了' },
    )
    expect(unsure.dispatch).toBeUndefined()
    expect(JSON.parse(unsure.content)).toMatchObject({
      dispatched: false,
      candidates: ['客服', '网站运营'],
    })
    expect(opened).toEqual([])
    const sure = await assistant.call(
      actor,
      { name: 'hand_to_position', input: { text: '回工单', position: '客服' } },
      { user_text: '让客服回工单' },
    )
    expect(sure.dispatch).toMatchObject({ position_name: '客服', matter_id: 'mat_1' })
    expect(opened).toEqual([{ position_id: 'care', text: '回工单' }])
  })

  it('@：不在本人名下的岗位不交；职责不是本人的就不带', async () => {
    const { assistant, opened } = make({
      positions: [
        position('care', '客服', [
          { role_id: 'dtc.support', role_name: '售后' },
          { role_id: 'dtc.presale', role_name: '售前', mine: false },
        ]),
      ],
    })
    expect(await assistant.direct(actor, { position_id: 'ops' }, '做')).toMatchObject({
      reason: expect.stringContaining('不在你名下'),
    })
    await assistant.direct(actor, { position_id: 'care', role_id: 'dtc.presale' }, '做')
    expect(opened).toEqual([{ position_id: 'care', text: '做' }])
  })

  it('回报：做完 / 要拍板 / 没做成各一句；已报过的、交出去之前的、已定的卡都不报', async () => {
    const ev = (e: Partial<MatterEvent>): MatterEvent =>
      ({ matter_id: 'mat_1', actor: { kind: 'agent', id: 'x' }, text: '', ...e }) as MatterEvent
    const { assistant } = make({
      positions: [],
      pending: new Set(['card_open']),
      timeline: [
        ev({
          id: 'e0',
          at: '2026-10-15T06:00:00.000Z',
          kind: 'agent_message',
          run_id: 'r0',
          text: '老的',
        }),
        ev({ id: 'e1', at: T, kind: 'card', approval_item_id: 'card_open', text: '回帖草稿' }),
        ev({ id: 'e2', at: T, kind: 'card', approval_item_id: 'card_done', text: '已定' }),
        ev({ id: 'e3', at: T, kind: 'agent_message', run_id: 'r1', text: '查到 3 条新帖' }),
        ev({
          id: 'e4',
          at: T,
          kind: 'status',
          run_id: 'r2',
          text: '没连 Reddit',
          failed: { code: 'x' } as never,
        }),
      ],
    })
    const row: AssistantDispatchRow = {
      matter_id: 'mat_1',
      session_id: 's',
      person_id: 'p_1',
      at: '2026-10-15T07:00:00.000Z',
      title: '查新帖',
      position_id: 'reddit',
      position_name: 'Reddit 运营',
      duty_name: '官方版块',
      reported: [],
    }
    const first = await assistant.progressOf(actor, row)
    expect(first.map((r) => [r.key, r.report.kind])).toEqual([
      ['card:card_open', 'decide'],
      ['done:r1', 'done'],
      ['failed:r2', 'failed'],
    ])
    expect(first[1]?.text).toBe('**Reddit 运营 · 官方版块** 做完了：查到 3 条新帖')
    const again = await assistant.progressOf(actor, { ...row, reported: first.map((r) => r.key) })
    expect(again).toEqual([])
  })

  it('等了多久说人话', () => {
    expect(waitedText('2026-10-15T07:30:00.000Z', T)).toBe('30 分钟')
    expect(waitedText('2026-10-15T03:00:00.000Z', T)).toBe('5 小时')
    expect(waitedText('2026-10-12T08:00:00.000Z', T)).toBe('3 天')
  })
})
