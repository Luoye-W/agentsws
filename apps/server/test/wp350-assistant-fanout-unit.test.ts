/**
 * WP350：拆成多份的服务端小规矩（不起服务进程）——附件读字（txt / md / docx / pdf、读不出照实说、口令抹掉）、
 * 一句话点了好几个岗位时派活工具提示改用方案卡、扇出时开事项失败照实记、要记的写不进去照实记。
 */
import type { PositionInstance } from '@agentsws/contracts'
import { zipFiles } from '@agentsws/knowledge'
import { describe, expect, it } from 'vitest'
import { createAssistant } from '../src/assistant.js'
import { taskSummaryOf } from '../src/assistant-fanout.js'
import {
  ASSISTANT_FILE_MAX_CHARS,
  readAssistantFile,
  redactSecrets,
  sourceKindOf,
} from '../src/assistant-files.js'

const actor = { workspace_id: 'ws_1', person_id: 'p_1', assignment_id: 'asg_owner' }
const T = '2026-10-16T08:00:00.000Z'
const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64')

const position = (
  id: string,
  zh: string,
  role_id: string,
  role_name: string,
): PositionInstance => ({
  position_id: id,
  workspace_id: 'ws_1' as never,
  name: { zh, en: zh },
  template_version: '1',
  holders: ['p_1' as never],
  roles: [
    {
      role_id: role_id as never,
      role_name,
      default: true,
      assignment_ids: ['a' as never],
      my_assignment_id: `asg_${role_id}` as never,
    },
  ],
  open_matters: 0,
  pending_cards: 0,
  memory_summary: '',
})
const positions = [
  position('reddit-ops', 'Reddit 运营', 'social.reddit', '自家版运营'),
  position('customer-care', '客服', 'dtc.support', '售后客服'),
  position('web-ops', '网站运营', 'dtc.store', '店铺管理'),
]

describe('readAssistantFile', () => {
  it('txt / md 直接读；名字像会议记录就是 meeting', () => {
    const a = readAssistantFile({
      name: '../x/10-16 周会纪要.md',
      data: b64('# 周会\n- 客服：回信'),
    })
    expect(a.name).toBe('10-16 周会纪要.md')
    expect(a.text).toBe('# 周会\n- 客服：回信')
    expect(a.chars).toBe(a.text?.length)
    expect(sourceKindOf(a)).toBe('meeting')
    expect(sourceKindOf(readAssistantFile({ name: '产品说明.txt', data: b64('参数') }))).toBe(
      'document',
    )
  })

  it('docx 读段落文字；pdf 读不出文字照实说；别的扩展名不收；改名的二进制不收', () => {
    const xml =
      '<w:document><w:body><w:p><w:r><w:t>客服：整理退货话术</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>网站运营：更新卖点</w:t></w:r></w:p></w:body></w:document>'
    const docx = zipFiles([{ path: 'word/document.xml', content: xml }])
    const d = readAssistantFile({ name: '纪要.docx', data: b64(docx) })
    expect(d.text).toContain('客服：整理退货话术')
    expect(d.text).toContain('网站运营：更新卖点')
    expect(
      readAssistantFile({ name: '扫描.pdf', data: b64('%PDF-1.4\n%%EOF') }).unreadable,
    ).toContain('PDF 读不出文字')
    expect(readAssistantFile({ name: '表.xlsx', data: b64('PK') }).unreadable).toContain('读不了')
    expect(
      readAssistantFile({ name: 'a.txt', data: b64(Buffer.from([0xff, 0xfe, 0x00, 0x01])) })
        .unreadable,
    ).toContain('不是文字')
  })

  it('口令抹掉（标签留着）、记几处；太长截断并说一句', () => {
    const r = redactSecrets('后台密码：hunter2\napi_key=sk-abcdefghijklmnopqrstuvwxyz0123')
    expect(r.text).not.toContain('hunter2')
    expect(r.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123')
    expect(r.text).toContain('后台密码：[已抹掉]')
    expect(r.redacted).toBeGreaterThanOrEqual(2)
    const long = readAssistantFile({
      name: 'long.txt',
      data: b64('字'.repeat(ASSISTANT_FILE_MAX_CHARS + 10)),
    })
    expect(long.text?.length).toBe(ASSISTANT_FILE_MAX_CHARS)
    expect(long.unreadable).toContain('只读了前')
  })
})

function make(opts: { failOn?: string; notes?: boolean } = {}) {
  const opened: { position_id: string; text: string; summary?: string }[] = []
  const proposed: number[] = []
  const assistant = createAssistant({
    clock: { now: () => T },
    positions: async () => positions,
    cards: async () => [],
    matters: () => [],
    timeline: () => [],
    cardPending: async () => false,
    newId: (p) => `${p}_1`,
    open: async (_a, x) => {
      if (x.position_id === opts.failOn) throw new Error('岗位那边开不了')
      opened.push(x)
      return { matter_id: `mat_${opened.length}`, title: x.text }
    },
    ...(opts.notes === false
      ? {}
      : {
          proposeNotes: async (_a, input) => {
            proposed.push(input.cards.length)
            return { card_ids: input.cards.map((_c, i) => `fc_${i}`), approval_id: 'apr_1' }
          },
        }),
  })
  return { assistant, opened, proposed }
}

describe('派活与扇出', () => {
  it('一句话点了好几个岗位：派活工具不乱派，提示改用方案卡', async () => {
    const { assistant, opened } = make()
    const got = await assistant.call(
      actor,
      { name: 'hand_to_position', input: { text: '让客服统一口径，网站运营改一下说明' } },
      { user_text: '让客服统一口径，网站运营改一下说明' },
    )
    expect(opened).toEqual([])
    expect(JSON.parse(got.content).hint).toContain('plan_fanout')
  })

  it('开事项失败的照实记进汇总，其余照发；没有知识库时要记的照实算没写进去', async () => {
    const { assistant, opened } = make({ failOn: 'web-ops', notes: false })
    const planned = await assistant.call(
      actor,
      {
        name: 'plan_fanout',
        input: {
          items: [
            { kind: 'task', text: '回差评', position: 'Reddit 运营' },
            { kind: 'task', text: '更新卖点', position: '网站运营' },
            { kind: 'note', text: '退货 30 天', position: '客服' },
          ],
        },
      },
      { user_text: '分一下', source: { name: '对话里的一段话', kind: 'human' } },
    )
    const view = planned.fanout
    if (view === undefined) throw new Error('没出方案卡')
    expect(view.batch_id).toBe('fan_1')
    expect(opened).toEqual([])
    const sent = await assistant.fanout.send(actor, view, [])
    expect(opened.map((o) => o.position_id)).toEqual(['reddit-ops'])
    expect(sent.summary.failed?.length).toBe(2)
    expect(sent.dispatches.every((d) => d.batch_id === 'fan_1')).toBe(true)
  })

  it('事项描述：为什么、截止、来自哪份资料、原文一段', () => {
    const text = taskSummaryOf(
      {
        id: 'i1',
        kind: 'task',
        text: '更新卖点',
        why: '会上定的',
        due: '周五前',
        quote: '网站运营：更新卖点',
      },
      { source: { name: 'a.md', kind: 'meeting' }, title: '10-16 周会', positions: 3 },
    )
    expect(text).toBe(
      '会上定的\n截止：周五前\n来自「10-16 周会」（同一批拆给了 3 个岗位）：\n> 网站运营：更新卖点',
    )
  })
})
