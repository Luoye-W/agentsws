/**
 * WP323：列对照（猜 / 校验 / 出一行）与飞书适配器（替身飞书，不连真实服务）。
 */
import type { OutboundRecord } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  createSinkAdapters,
  dingtalkPlaceholder,
  googleSheetsPlaceholder,
} from '../src/outbound/adapters.js'
import {
  clientTokenOf,
  createFeishuSinkAdapter,
  FEISHU_SCOPES,
  parseFeishuUrl,
} from '../src/outbound/feishu.js'
import { buildMapping, guessColumns, renderRow } from '../src/outbound/mapping.js'
import { createFakeFeishu } from './fake-feishu-api.js'

const WS = 'ws_a' as never

const rec = (over: Partial<OutboundRecord> = {}): OutboundRecord => ({
  id: 'ob_1',
  workspace_id: WS,
  source_key: 'approval:apv_1',
  sent_at: '2026-10-14T02:30:00.000Z',
  channel: 'reddit',
  action: 'reply',
  kind: 'outbound_draft',
  destination: 'r/ivraxr',
  thread_title: 'Battery life?',
  thread_url: 'https://www.reddit.com/r/ivraxr/comments/abc/',
  counterpart: 'u/alice',
  counterpart_text: 'How long does it last?',
  content: 'About 3 hours of active use.',
  link: 'https://www.reddit.com/r/ivraxr/comments/abc/_/def/',
  external_id: 't1_def',
  approved_by: 'Luoye',
  status: 'sent',
  follow_ups: [],
  ...over,
})

describe('列对照', () => {
  it('按表头猜：docs/102 的例子五列都对上', () => {
    const cols = guessColumns(
      ['日期', '版块', '帖子链接', '我们回复的内容', '状态'].map((name) => ({
        name,
        type: 'text',
      })),
    )
    expect(cols.map((c) => (c.source.from === 'field' ? c.source.field : c.source.from))).toEqual([
      'sent_date',
      'destination',
      'thread_url',
      'content',
      'status',
    ])
  })

  it('AI 给的对照：不存在的列记下来，没给的列按名字猜，非法字段丢掉', () => {
    const m = buildMapping(
      [
        { name: '日期', type: 'date' },
        { name: '版块', type: 'text' },
        { name: '备注', type: 'text' },
      ],
      [
        { column: '日期', source: { field: 'sent_at', format: { date: 'YYYY/MM/DD' } } },
        { column: '负责人', source: { value: 'Luoye' } },
        { column: '备注', source: { field: 'secret_token' } },
      ],
    )
    expect(m.unknown).toEqual(['负责人'])
    expect(m.columns[0]?.source).toEqual({
      from: 'field',
      field: 'sent_at',
      format: { date: 'YYYY/MM/DD' },
    })
    expect(m.columns[1]?.source).toEqual({ from: 'field', field: 'destination' })
    expect(m.empty).toEqual(['备注'])
  })

  it('新表（没表头）：AI 给的列就是要写的表头', () => {
    const m = buildMapping(
      [],
      [
        { column: '日期', source: { field: 'sent_date' } },
        { column: '内容', source: { field: 'content', format: { max_chars: 10 } } },
      ],
    )
    expect(m.columns.map((c) => c.column)).toEqual(['日期', '内容'])
  })

  it('出一行：日期按本地时区与写法、动作写中文、替换表、截断；值不经模型', () => {
    const cells = renderRow(
      rec(),
      [
        {
          column: '日期',
          source: { from: 'field', field: 'sent_at', format: { date: 'YYYY/MM/DD HH:mm' } },
        },
        { column: '动作', source: { from: 'field', field: 'action' } },
        {
          column: '状态',
          source: { from: 'field', field: 'status', format: { map: { sent: '已回复' } } },
        },
        { column: '内容', source: { from: 'field', field: 'content', format: { max_chars: 6 } } },
        { column: '负责人', source: { from: 'const', value: 'Luoye' } },
        { column: '空', source: { from: 'empty' } },
      ],
      480,
    )
    expect(cells.map((c) => c.text)).toEqual([
      '2026/10/14 10:30',
      '回复',
      '已回复',
      'About…',
      'Luoye',
      '',
    ])
    expect(cells[0]?.ms).toBe(Date.parse('2026-10-14T02:30:00.000Z'))
  })
})

describe('飞书适配器（替身）', () => {
  const setup = (creds = true) => {
    const fake = createFakeFeishu()
    fake.bitables.set(
      'bascnAAA111',
      new Map([
        [
          'tblX1',
          {
            name: '回复记录',
            fields: [
              { field_name: '日期', type: 5 },
              { field_name: '版块', type: 3, options: ['r/ivraxr'] },
              { field_name: '帖子链接', type: 15 },
              { field_name: '回复内容', type: 1 },
              { field_name: '对方回复数', type: 2 },
            ],
            records: [{ 版块: 'r/ivraxr', 回复内容: 'hi' }],
          },
        ],
      ]),
    )
    fake.sheets.set('shtcnBBB222', new Map([['s1', []]]))
    fake.wiki.set('wikcnCCC333', { obj_type: 'bitable', obj_token: 'bascnAAA111' })
    fake.shared.add('bascnAAA111')
    fake.shared.add('shtcnBBB222')
    const adapter = createFeishuSinkAdapter({
      credentials: () => (creds ? { app_id: 'cli_test', app_secret: 'test-secret' } : undefined),
      fetch: fake.fetch,
    })
    return { fake, adapter }
  }

  it('认链接：多维表格 / 电子表格 / 知识库；别家只留口子', () => {
    expect(parseFeishuUrl('https://x.feishu.cn/base/bascnAAA111?table=tblX1&view=v')).toEqual({
      kind: 'bitable',
      token: 'bascnAAA111',
      sub: 'tblX1',
    })
    expect(parseFeishuUrl('https://x.feishu.cn/sheets/shtcnBBB222?sheet=s1')?.kind).toBe('sheet')
    expect(parseFeishuUrl('https://x.larksuite.com/wiki/wikcnCCC333')?.kind).toBe('wiki')
    expect(parseFeishuUrl('https://evil.example.com/base/bascnAAA111')).toBeUndefined()
    const { adapter } = setup()
    const all = createSinkAdapters([adapter, googleSheetsPlaceholder, dingtalkPlaceholder])
    expect(all.forUrl('https://docs.google.com/spreadsheets/d/abc/edit')?.id).toBe('google_sheets')
    expect(all.forUrl('https://alidocs.dingtalk.com/i/nodes/abc')?.id).toBe('dingtalk')
    expect(all.byKind('feishu_bitable')?.id).toBe('feishu')
  })

  it('多维表格：读表头（类型、单选项、样例）→ 写一行按列类型转值，同一把键不写两次', async () => {
    const { fake, adapter } = setup()
    const info = await adapter.inspect(WS, 'https://x.feishu.cn/base/bascnAAA111')
    if (!info.ok) throw new Error(info.message)
    expect(info.data.ref).toEqual({ app_token: 'bascnAAA111', table_id: 'tblX1' })
    expect(info.data.columns[0]).toEqual({ name: '日期', type: 'date' })
    expect(info.data.columns[1]).toEqual({ name: '版块', type: 'select', options: ['r/ivraxr'] })
    expect(info.data.samples[0]?.[1]).toBe('r/ivraxr')
    const columns = guessColumns(info.data.columns).map((c) =>
      c.column === '对方回复数'
        ? { ...c, source: { from: 'field' as const, field: 'follow_up_count' as const } }
        : c,
    )
    const cells = renderRow(rec(), columns, 480)
    const once = await adapter.append({
      workspace_id: WS,
      url: '',
      ref: info.data.ref,
      cells,
      key: 'sink_1:ob_1',
    })
    const twice = await adapter.append({
      workspace_id: WS,
      url: '',
      ref: info.data.ref,
      cells,
      key: 'sink_1:ob_1',
    })
    expect(once.ok && twice.ok && once.data.row_ref === twice.data.row_ref).toBe(true)
    const rows = fake.bitables.get('bascnAAA111')?.get('tblX1')?.records ?? []
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual({
      日期: Date.parse('2026-10-14T02:30:00.000Z'),
      版块: 'r/ivraxr',
      帖子链接: { text: rec().thread_url, link: rec().thread_url },
      回复内容: 'About 3 hours of active use.',
      对方回复数: 0,
    })
    const create = fake.calls.find((c) => c.method === 'POST' && c.path.includes('/records'))
    expect(create?.path).toContain(`client_token=${clientTokenOf('sink_1:ob_1')}`)
    expect(clientTokenOf('a')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('电子表格：空表第一次写先写表头，之后不再写', async () => {
    const { fake, adapter } = setup()
    const info = await adapter.inspect(WS, 'https://x.feishu.cn/sheets/shtcnBBB222')
    if (!info.ok) throw new Error(info.message)
    expect(info.data.columns).toEqual([])
    expect(info.data.ref.header_missing).toBe('1')
    const columns = buildMapping(
      [],
      [
        { column: '日期', source: { field: 'sent_date' } },
        { column: '内容', source: { field: 'content' } },
      ],
    ).columns
    const first = await adapter.append({
      workspace_id: WS,
      url: '',
      ref: info.data.ref,
      cells: renderRow(rec(), columns, 480),
      key: 'k1',
    })
    expect(first.ok && first.data.ref_patch).toEqual({ header_missing: '' })
    const { header_missing: _h, ...ref } = info.data.ref
    await adapter.append({
      workspace_id: WS,
      url: '',
      ref,
      cells: renderRow(rec(), columns, 480),
      key: 'k2',
    })
    expect(fake.sheets.get('shtcnBBB222')?.get('s1')).toEqual([
      ['日期', '内容'],
      ['2026-10-14', 'About 3 hours of active use.'],
      ['2026-10-14', 'About 3 hours of active use.'],
    ])
  })

  it('知识库里的表先认出是哪种', async () => {
    const { adapter } = setup()
    const info = await adapter.inspect(WS, 'https://x.feishu.cn/wiki/wikcnCCC333?table=tblX1')
    expect(info.ok && info.data.adapter).toBe('feishu_bitable')
  })

  it('失败照实分类：没接应用 / 没共享（给权限范围那一步）/ 临时错 / 令牌过期重取', async () => {
    const none = setup(false)
    const nc = await none.adapter.inspect(WS, 'https://x.feishu.cn/base/bascnAAA111')
    expect(!nc.ok && nc.code).toBe('not_configured')
    expect(none.adapter.setupHint('not_configured')).toContain('消息渠道')

    const { fake, adapter } = setup()
    fake.shared.delete('bascnAAA111')
    const denied = await adapter.inspect(WS, 'https://x.feishu.cn/base/bascnAAA111')
    expect(!denied.ok && denied.code).toBe('no_permission')
    for (const scope of FEISHU_SCOPES) expect(adapter.setupHint('no_permission')).toContain(scope)
    expect(adapter.setupHint('no_permission')).toContain('添加文档应用')
    fake.shared.add('bascnAAA111')

    fake.failNext(/fields$/, { status: 500, code: 1254000, msg: 'internal' })
    const busy = await adapter.inspect(WS, 'https://x.feishu.cn/base/bascnAAA111')
    expect(!busy.ok && busy.code).toBe('transient')
    fake.failNext(/tables$/, 'throw')
    const down = await adapter.inspect(WS, 'https://x.feishu.cn/base/bascnAAA111')
    expect(!down.ok && down.code).toBe('transient')

    const before = fake.tokensIssued
    fake.expireTokens()
    const again = await adapter.inspect(WS, 'https://x.feishu.cn/base/bascnAAA111')
    expect(again.ok).toBe(true)
    expect(fake.tokensIssued).toBe(before + 1)

    const gone = await adapter.append({
      workspace_id: WS,
      url: '',
      ref: { app_token: 'bascnAAA111', table_id: 'tblX1' },
      cells: [{ column: '不存在的列', type: 'text', text: 'x' }],
      key: 'k',
    })
    expect(!gone.ok && gone.code).toBe('columns_changed')
  })
})
