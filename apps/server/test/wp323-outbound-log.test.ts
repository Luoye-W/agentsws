/**
 * WP323：发出记录 + 记录去处的整条流程（替身飞书）：
 * 记一条（去重）→ 交代（读表头、生成对照、出「定规矩」卡、带一行真实预览）→ 记下 → 每条照写 →
 * 临时错误退避 → 停下来的错留待补写、补写 → 列变了重出卡 → 删去处连带清掉排着的写入；
 * 后续挂回、对方删了原话我们也清、导出。
 */
import type { ApprovalItem, OutboundRecordInput } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createSinkAdapters } from '../src/outbound/adapters.js'
import { createFeishuSinkAdapter } from '../src/outbound/feishu.js'
import { createOutboundLog, type SinkCardInput } from '../src/outbound/log.js'
import { createOutboundStore } from '../src/outbound/store.js'
import { createFakeFeishu } from './fake-feishu-api.js'

const WS = 'ws_a' as never
const URL_A = 'https://x.feishu.cn/base/bascnAAA111?table=tblX1'

function setup() {
  const fake = createFakeFeishu()
  fake.bitables.set(
    'bascnAAA111',
    new Map([
      [
        'tblX1',
        {
          name: '回复记录',
          fields: [
            { field_name: '日期', type: 1 },
            { field_name: '版块', type: 1 },
            { field_name: '帖子链接', type: 15 },
            { field_name: '我们回复的内容', type: 1 },
            { field_name: '状态', type: 1 },
          ],
          records: [],
        },
      ],
    ]),
  )
  fake.shared.add('bascnAAA111')
  let t = Date.parse('2026-10-14T02:00:00.000Z')
  let n = 0
  const cards: SinkCardInput[] = []
  const withdrawn: string[] = []
  const events: string[] = []
  const log = createOutboundLog({
    store: createOutboundStore(),
    adapters: createSinkAdapters([
      createFeishuSinkAdapter({
        credentials: () => ({ app_id: 'cli_test', app_secret: 'test-secret' }),
        fetch: fake.fetch,
        nowMs: () => t,
      }),
    ]),
    now: () => new Date(t).toISOString(),
    newId: (p) => `${p}${++n}`,
    tzOffsetMinutes: () => 480,
    emit: (_ws, type) => events.push(type),
    stageCard: async (input) => {
      cards.push(input)
      return `apv_${cards.length}`
    },
    withdrawCard: async (id) => {
      withdrawn.push(id)
    },
  })
  const rows = () => fake.bitables.get('bascnAAA111')?.get('tblX1')?.records ?? []
  const advance = (ms: number) => {
    t += ms
  }
  return { fake, log, cards, withdrawn, events, rows, advance }
}

const input = (i: number, over: Partial<OutboundRecordInput> = {}): OutboundRecordInput => ({
  source_key: `approval:apv_r${i}`,
  channel: 'reddit',
  action: 'reply',
  kind: 'outbound_draft',
  destination: 'r/inmoxr',
  thread_url: `https://www.reddit.com/r/inmoxr/comments/p${i}/`,
  content: `reply ${i}`,
  external_id: `t1_r${i}`,
  parent_external_id: `t3_p${i}`,
  counterpart: 'u/alice',
  counterpart_text: 'question?',
  approved_by: 'Luoye',
  ...over,
})

const decided = (
  card: string,
  sink_id: string,
  state: ApprovalItem['state'],
  option = 'after',
): ApprovalItem =>
  ({
    id: card,
    workspace_id: WS,
    kind: 'policy_change',
    state,
    payload: { form: 'record_sink', sink_id },
    decision: { by: 'p_1', at: '2026-10-14T03:00:00.000Z', selected_option_id: option },
  }) as unknown as ApprovalItem

const actor = { person_id: 'p_1', assignment_id: 'asg_1', role_id: 'social.reddit' }

async function confirmed(s: ReturnType<typeof setup>) {
  const p = await s.log.propose(WS, {
    url: URL_A,
    instruction: '以后每发一条 Reddit 都记到这张表，日期写成 2026/10/14',
    name: 'INMO 回复记录',
    columns: [{ column: '日期', source: { field: 'sent_date', format: { date: 'YYYY/MM/DD' } } }],
    filter: { channels: ['reddit'] },
    actor,
  })
  if (!p.ok) throw new Error(p.message)
  await s.log.onDecided(decided(p.card_id as string, p.sink_id, 'approved'))
  return p
}

describe('发出记录', () => {
  it('同一条只记一次；新的在前；导出 CSV 带 BOM 与表头', () => {
    const { log } = setup()
    const a = log.record(WS, input(1))
    expect(log.record(WS, input(1)).id).toBe(a.id)
    log.record(WS, input(2, { content: 'has "quote", comma' }))
    expect(log.list(WS).map((r) => r.content)).toEqual(['has "quote", comma', 'reply 1'])
    const csv = log.export(WS, 'csv')
    expect(csv.count).toBe(2)
    expect(csv.content.startsWith('﻿时间,渠道,动作')).toBe(true)
    expect(csv.content).toContain('"has ""quote"", comma"')
    expect(log.list('ws_other' as never)).toEqual([])
  })

  it('后续挂回那一行；我们再回也挂上；对方删了原话我们也清掉', () => {
    const { log } = setup()
    const a = log.record(WS, input(1))
    log.addFollowUp(WS, {
      parent_external_id: 't1_r1',
      author: 'u/alice',
      text: 'thanks!',
      external_id: 't1_f1',
    })
    log.addFollowUp(WS, {
      parent_external_id: 't1_r1',
      author: 'u/alice',
      text: 'thanks!',
      external_id: 't1_f1',
    })
    expect(log.addFollowUp(WS, { parent_external_id: 'nope', text: 'x' })).toBeUndefined()
    const ours = log.record(WS, input(9, { parent_external_id: 't1_f1', external_id: 't1_r9' }))
    const row = log.get(WS, a.id)
    expect(row?.follow_ups.map((f) => f.from)).toEqual(['them', 'us'])
    expect(row?.follow_ups[1]?.record_id).toBe(ours.id)
    // 那一条后续的原话 + 我们回它的那一行里存的「对方原话」都清掉
    expect(log.counterpartDeleted(WS, 't1_f1')).toBe(2)
    expect(log.get(WS, a.id)?.follow_ups[0]).toMatchObject({ deleted: true })
    expect(log.get(WS, a.id)?.follow_ups[0]?.text).toBeUndefined()
    log.counterpartDeleted(WS, 't3_p1')
    expect(log.get(WS, a.id)).toMatchObject({ counterpart_deleted: true, content: 'reply 1' })
    expect(log.get(WS, a.id)?.counterpart_text).toBeUndefined()
  })
})

describe('记录去处', () => {
  it('交代 → 读表头生成对照 → 「定规矩」卡带最近一条真实记录的预览 → 记下后每条照写', async () => {
    const s = setup()
    s.log.record(WS, input(1))
    const p = await s.log.propose(WS, {
      url: URL_A,
      instruction: '记到这张表',
      name: 'INMO 回复记录',
      columns: [{ column: '日期', source: { field: 'sent_date', format: { date: 'YYYY/MM/DD' } } }],
      actor,
    })
    if (!p.ok) throw new Error(p.message)
    expect(p.columns.map((c) => c.fill)).toEqual([
      '发出日期（YYYY/MM/DD）',
      '发到哪',
      '原帖链接',
      '我们发的内容',
      '状态',
    ])
    expect(p.sample).toBe(false)
    expect(s.cards[0]?.preview).toEqual([
      ['日期', '2026/10/14'],
      ['版块', 'r/inmoxr'],
      ['帖子链接', 'https://www.reddit.com/r/inmoxr/comments/p1/'],
      ['我们回复的内容', 'reply 1'],
      ['状态', '已发'],
    ])
    // 确认之前发的不写
    s.log.record(WS, input(2))
    await s.log.flush()
    expect(s.rows()).toHaveLength(0)
    await s.log.onDecided(decided(p.card_id as string, p.sink_id, 'approved'))
    expect(s.log.sinks(WS)[0]).toMatchObject({ state: 'active', name: 'INMO 回复记录' })
    s.log.record(WS, input(3))
    await s.log.flush()
    expect(s.rows()).toEqual([
      {
        日期: '2026/10/14',
        版块: 'r/inmoxr',
        帖子链接: {
          text: 'https://www.reddit.com/r/inmoxr/comments/p3/',
          link: 'https://www.reddit.com/r/inmoxr/comments/p3/',
        },
        我们回复的内容: 'reply 3',
        状态: '已发',
      },
    ])
    expect(s.log.sinks(WS)[0]).toMatchObject({ written: 1, pending: 0 })
  })

  it('没有记录时预览用示例；第一次就说「不用」= 去处不留；筛选只记命中的', async () => {
    const s = setup()
    const p = await s.log.propose(WS, { url: URL_A, instruction: 'x', actor })
    if (!p.ok) throw new Error(p.message)
    expect(p.sample).toBe(true)
    await s.log.onDecided(decided(p.card_id as string, p.sink_id, 'approved', 'before'))
    expect(s.log.sinks(WS)).toEqual([])
    await confirmed(s)
    s.log.record(WS, input(4, { channel: 'email', action: 'email' }))
    await s.log.flush()
    expect(s.rows()).toHaveLength(0)
  })

  it('临时错误退避重试；没权限停下、留待补写、照实说；补写后写进去', async () => {
    const s = setup()
    const p = await confirmed(s)
    s.fake.failNext(/records$/, { status: 503, code: 0, msg: 'busy' })
    s.log.record(WS, input(5))
    await s.log.flush()
    expect(s.rows()).toHaveLength(0)
    expect(s.log.sinks(WS)[0]).toMatchObject({ state: 'active', pending: 1 })
    await s.log.flush() // 还没到点：不再打
    expect(s.rows()).toHaveLength(0)
    s.advance(31_000)
    await s.log.flush()
    expect(s.rows()).toHaveLength(1)

    s.fake.shared.delete('bascnAAA111')
    s.log.record(WS, input(6))
    s.log.record(WS, input(7))
    await s.log.flush()
    const broken = s.log.sinks(WS)[0]
    expect(broken).toMatchObject({ state: 'broken', pending: 2 })
    expect(broken?.last_error?.code).toBe('no_permission')
    // 写不进去时新发的照样排进「待补写」
    s.log.record(WS, input(8))
    expect(s.log.sinks(WS)[0]?.pending).toBe(3)
    s.fake.shared.add('bascnAAA111')
    expect(await s.log.retry(WS, p.sink_id)).toBe(3)
    expect(s.log.sinks(WS)[0]).toMatchObject({ state: 'active', pending: 0, written: 4 })
    expect(s.rows()).toHaveLength(4)
    expect(s.events).toContain('outbound.sink_failed')
  })

  it('列变了：停下来，重读表头、沿用对得上的列，重出一张「定规矩」卡；记下后补写', async () => {
    const s = setup()
    const p = await confirmed(s)
    const table = s.fake.bitables.get('bascnAAA111')?.get('tblX1')
    if (table === undefined) throw new Error('no table')
    table.fields = table.fields.map((f) =>
      f.field_name === '状态' ? { ...f, field_name: '进度' } : f,
    )
    s.log.record(WS, input(10))
    await s.log.flush()
    const sink = s.log.sinks(WS)[0]
    expect(sink?.state).toBe('broken')
    expect(s.cards).toHaveLength(2)
    expect(s.cards[1]).toMatchObject({ revision: true, reason: 'columns_changed' })
    expect(sink?.draft?.columns.map((c) => c.column)).toContain('进度')
    expect(sink?.draft?.columns[0]?.source).toEqual({
      from: 'field',
      field: 'sent_date',
      format: { date: 'YYYY/MM/DD' },
    })
    await s.log.onDecided(decided(sink?.draft?.card_id as string, p.sink_id, 'approved'))
    expect(s.log.sinks(WS)[0]).toMatchObject({ state: 'active', pending: 0 })
    expect(s.rows()).toHaveLength(1)
  })

  it('改：再交代一次出新卡，旧对照照用到批了为止；停了不写；删了连带清掉排着的写入', async () => {
    const s = setup()
    const p = await confirmed(s)
    const again = await s.log.propose(WS, {
      url: URL_A,
      instruction: '日期改成 10-14 这种',
      columns: [{ column: '日期', source: { field: 'sent_date', format: { date: 'MM-DD' } } }],
      actor,
    })
    expect(again.ok && again.revision).toBe(true)
    s.log.record(WS, input(11))
    await s.log.flush()
    expect(s.rows()[0]?.日期).toBe('2026/10/14')
    await s.log.onDecided(decided(`apv_${s.cards.length}`, p.sink_id, 'approved'))
    s.log.record(WS, input(12))
    await s.log.flush()
    expect(s.rows()[1]?.日期).toBe('10-14')

    s.log.pause(WS, p.sink_id)
    s.log.record(WS, input(13))
    await s.log.flush()
    expect(s.rows()).toHaveLength(2)
    s.log.resume(WS, p.sink_id)

    s.fake.shared.delete('bascnAAA111')
    s.log.record(WS, input(14))
    await s.log.flush()
    expect(s.log.sinks(WS)[0]?.pending).toBe(1)
    expect(await s.log.remove(WS, p.sink_id)).toBe(true)
    expect(s.log.sinks(WS)).toEqual([])
    s.fake.shared.add('bascnAAA111')
    s.log.record(WS, input(15))
    await s.log.flush()
    expect(s.rows()).toHaveLength(2)
    // 别的品牌删不了
    expect(await s.log.remove('ws_other' as never, p.sink_id)).toBe(false)
  })

  it('删一个还在等确认的去处：撤掉那张卡', async () => {
    const s = setup()
    const p = await s.log.propose(WS, { url: URL_A, instruction: 'x', actor })
    if (!p.ok) throw new Error(p.message)
    await s.log.remove(WS, p.sink_id)
    expect(s.withdrawn).toEqual([p.card_id])
  })

  it('认不出的链接 / 没权限：照实说，并给出那一家要做的那一步', async () => {
    const s = setup()
    const bad = await s.log.propose(WS, { url: 'https://example.com/x', instruction: 'x', actor })
    expect(!bad.ok && bad.code).toBe('unknown_link')
    s.fake.shared.delete('bascnAAA111')
    const denied = await s.log.inspect(WS, URL_A)
    expect(!denied.ok && denied.hint).toContain('添加文档应用')
  })
})
