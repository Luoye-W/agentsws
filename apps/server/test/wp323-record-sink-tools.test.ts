/**
 * WP323：记录去处的三个工具（AI 在运行里用的通用能力）+ stub 剧本的岔口与回话。
 * 白名单出参：没有表格 token、没有应用凭据、没有记录正文。
 */
import type { RunRequest } from '@agentsws/contracts'
import {
  LIST_RECORD_SINKS_TOOL,
  PROPOSE_RECORD_SINK_TOOL,
  READ_RECORD_TARGET_TOOL,
  RECORD_SINK_TOOL_NAMES,
  recordSinkBranch,
  renderRecordSinkAnswer,
} from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { createSinkAdapters } from '../src/outbound/adapters.js'
import { createFeishuSinkAdapter } from '../src/outbound/feishu.js'
import { createOutboundLog } from '../src/outbound/log.js'
import { createOutboundStore } from '../src/outbound/store.js'
import { createRecordSinkToolExecutor } from '../src/outbound/tools.js'
import { createFakeFeishu } from './fake-feishu-api.js'

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
            { field_name: '回复内容', type: 1 },
          ],
          records: [{ 日期: '2026/10/13', 版块: 'r/ivraxr', 回复内容: 'old' }],
        },
      ],
    ]),
  )
  fake.shared.add('bascnAAA111')
  let n = 0
  const log = createOutboundLog({
    store: createOutboundStore(),
    adapters: createSinkAdapters([
      createFeishuSinkAdapter({
        credentials: () => ({ app_id: 'cli_test', app_secret: 'test-secret' }),
        fetch: fake.fetch,
      }),
    ]),
    now: () => '2026-10-14T02:00:00.000Z',
    newId: (p) => `${p}${++n}`,
    stageCard: async () => `apv_${++n}`,
  })
  const exec = createRecordSinkToolExecutor({ log: () => log })
  const request = {
    workspace_id: 'ws_a',
    actor: { person_id: 'p_1', assignment_id: 'asg_1', role_id: 'social.reddit' },
    work_item: { id: 'mat_1' },
    tools: { allow: [...RECORD_SINK_TOOL_NAMES] },
  } as unknown as RunRequest
  const run = (name: string, input: Record<string, unknown>) => exec({ name, input, request })
  return { fake, log, run, request }
}

describe('记录去处的工具', () => {
  it('读表头：列、样例、能选的标准字段；不带 token', async () => {
    const { run } = setup()
    const r = await run(READ_RECORD_TARGET_TOOL, { url: URL_A })
    expect(r.status).toBe('ok')
    const data = r.data as Record<string, unknown>
    expect(data.columns).toEqual([
      { name: '日期', type: 'text' },
      { name: '版块', type: 'text' },
      { name: '回复内容', type: 'text' },
    ])
    expect(data.samples).toEqual([['2026/10/13', 'r/ivraxr', 'old']])
    expect(JSON.stringify(data)).not.toMatch(/bascn|tblX1|test-secret|cli_test/)
  })

  it('配置：扁平写法的列 → 对照、出卡；列出来看得到「等你确认」', async () => {
    const { run } = setup()
    const r = await run(PROPOSE_RECORD_SINK_TOOL, {
      url: URL_A,
      instruction: '每发一条记到这张表，日期写成 2026/10/14',
      name: 'IVRA 回复记录',
      columns: [
        { column: '日期', field: 'sent_date', date: 'YYYY/MM/DD' },
        { column: '负责人', value: 'Luoye' },
      ],
      channels: ['reddit'],
    })
    expect(r.status).toBe('ok')
    expect(r.data).toMatchObject({
      ok: true,
      name: 'IVRA 回复记录',
      card: true,
      unknown: ['负责人'],
      columns: [
        { column: '日期', fill: '发出日期（YYYY/MM/DD）' },
        { column: '版块', fill: '发到哪' },
        { column: '回复内容', fill: '我们发的内容' },
      ],
    })
    const list = await run(LIST_RECORD_SINKS_TOOL, {})
    expect((list.data as { sinks: unknown[] }).sinks).toMatchObject([
      { name: 'IVRA 回复记录', state: '等你确认', written: 0, pending: 0 },
    ])
    expect(JSON.stringify(list.data)).not.toMatch(/bascn|tblX1/)
  })

  it('读不了：照实说 + 那一家要做的那一步（由 AI 转告）', async () => {
    const { run, fake } = setup()
    fake.shared.delete('bascnAAA111')
    const r = await run(PROPOSE_RECORD_SINK_TOOL, { url: URL_A, instruction: 'x' })
    expect(r.data).toMatchObject({ ok: false })
    expect((r.data as { hint: string }).hint).toContain('bitable:app')
    expect(renderRecordSinkAnswer({ data: r.data as never })).toContain('添加文档应用')
  })
})

describe('stub 剧本', () => {
  it('有表格链接 + 「记到」才走这一支；回话说清怎么填、去卡上点「记下」', () => {
    const req = { tools: { allow: [...RECORD_SINK_TOOL_NAMES] } } as unknown as RunRequest
    expect(recordSinkBranch(req, `以后每发一条都记到这张表 ${URL_A}`)).toEqual({
      tool: PROPOSE_RECORD_SINK_TOOL,
      input: { url: URL_A, instruction: `以后每发一条都记到这张表 ${URL_A}` },
    })
    expect(recordSinkBranch(req, `看看这张表 ${URL_A}`)).toBeUndefined()
    expect(
      recordSinkBranch({ tools: { allow: [] } } as unknown as RunRequest, `记到 ${URL_A}`),
    ).toBeUndefined()
    const text = renderRecordSinkAnswer({
      data: {
        ok: true,
        name: 'IVRA 回复记录',
        card: true,
        columns: [{ column: '日期', fill: '发出日期' }],
      },
    })
    expect(text).toContain('日期 ← 发出日期')
    expect(text).toContain('记下')
  })
})
