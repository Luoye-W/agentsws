/**
 * WP322 端到端：**传一份 FAQ 表 → 出一张定规矩卡 → 点「记下」→ 一行一张知识卡 → 检索得到**。
 *
 * 跑的是真装配线：真上传路由 → 真对象存储（本地档）→ 后台认列 → 真审批总线（带出卡钩子）→
 * 真决定路由 → 真知识库 → 真检索路由。表是现编的假问答（多张工作表、表头不在第一行、合并的分类、
 * 中英两种），不放任何真实客户数据。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem, FaqImportPayload } from '@agentsws/contracts'
import { zipFiles } from '@agentsws/knowledge'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-14T09:00:00.000Z'

let server: Server | undefined
let dir: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 一份最小的真 xlsx：每张表行内字串（`inlineStr`），可带合并格。 */
function xlsx(sheets: { name: string; rows: string[][]; merges?: string[] }[]): Uint8Array {
  const col = (c: number) => String.fromCharCode(65 + c)
  const sheetXml = sheets.map(
    (s) =>
      `<worksheet><sheetData>${s.rows
        .map(
          (row, r) =>
            `<row r="${r + 1}">${row
              .map((v, c) =>
                v === ''
                  ? ''
                  : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`,
              )
              .join('')}</row>`,
        )
        .join('')}</sheetData>${
        s.merges === undefined
          ? ''
          : `<mergeCells>${s.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      }</worksheet>`,
  )
  return new Uint8Array(
    zipFiles([
      {
        path: 'xl/workbook.xml',
        content: `<workbook><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
      },
      {
        path: 'xl/_rels/workbook.xml.rels',
        content: `<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
      },
      ...sheetXml.map((content, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, content })),
    ]),
  )
}

async function boot() {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp322-'))
  const s = await createServer({
    clock: { now: () => T0 },
    random: () => 0.42,
    quiet: true,
    startRun: false,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    dbDir: dir,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
  })
  server = s
  const call = (method: string, path: string, body?: BodyInit, json = false) =>
    s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': s.bootstrap.ownerAssignment.id,
          ...(json ? { 'content-type': 'application/json' } : {}),
        },
        ...(body === undefined ? {} : { body }),
      }),
    )
  const upload = async (name: string, bytes: Uint8Array) => {
    const fd = new FormData()
    fd.set('file', new Blob([bytes as unknown as ArrayBuffer]), name)
    const res = await call('POST', '/v1/knowledge/sources/upload', fd)
    expect(res.status).toBe(201)
    await s.faqImport.settled()
  }
  const importCards = async (): Promise<ApprovalItem[]> =>
    (
      await s.txn.approvals.queue({
        workspace_id: s.bootstrap.workspace.id,
        person_id: s.bootstrap.person.id,
        lane: 'mine',
      })
    ).filter((i) => (i.payload as { form?: string }).form === 'faq_import')
  const decide = async (item: ApprovalItem, option: string) => {
    const fresh = await s.txn.approvals.get(item.id)
    const token = [...(fresh?.deliveries ?? [])]
      .reverse()
      .find((d) => d.status === 'sent')?.decision_token
    const res = await call(
      'POST',
      `/v1/approvals/${item.id}/decide`,
      JSON.stringify({ decision_token: token, action: 'approve', selected_option_id: option }),
      true,
    )
    expect(res.status).toBe(200)
    await s.faqImport.settled()
  }
  return { s, call, upload, importCards, decide }
}

const TABLE = [
  {
    name: '中文问答',
    rows: [
      ['小蓝灯常见问题', '小蓝灯常见问题', '小蓝灯常见问题'],
      ['', '', ''],
      ['问题分类', '客户常见问题', '标准回复话术'],
      ['续航', '充一次电能用多久？', '正常使用约 6 小时。'],
      ['', '充满要多久？', '约 90 分钟。'],
    ],
    merges: ['A1:C1', 'A4:A5'],
  },
  {
    name: 'English',
    rows: [
      ['Question', 'Answer (EN)', 'Lang'],
      ['Is it waterproof?', 'Splash resistant only, do not submerge.', 'en'],
    ],
  },
  {
    name: '价目',
    rows: [
      ['SKU', '价格'],
      ['LB-1', '99'],
    ],
  },
]

describe('WP322 端到端：传 FAQ 表 → 定规矩卡 → 记下 → 知识卡 → 检索得到', () => {
  it('一张卡；记下后一行一张卡（出处 文件 › 表 › 行）、当场生效、检索中英都命中；再传改过的表出更新', async () => {
    const { s, call, upload, importCards, decide } = await boot()
    await upload('小蓝灯FAQ.xlsx', xlsx(TABLE))

    const [card, ...more] = await importCards()
    expect(more).toHaveLength(0)
    const p = card?.payload as FaqImportPayload
    expect(card?.title).toBe('「小蓝灯FAQ.xlsx」导入 3 条问答')
    expect(p.sheets.map((m) => [m.sheet, m.header_row, m.rows])).toEqual([
      ['中文问答', 3, 2],
      ['English', 1, 1],
    ])

    await decide(card as ApprovalItem, 'all')
    const cards = (
      (await (await call('GET', '/v1/knowledge/cards')).json()) as {
        data: { subject: { type: string }; status: string; provenance: { locator?: string }[] }[]
      }
    ).data.filter((c) => c.subject.type === 'faq')
    expect(cards.map((c) => c.status)).toEqual(['active', 'active', 'active'])
    expect(cards.map((c) => c.provenance[0]?.locator).sort()).toEqual([
      '小蓝灯FAQ.xlsx › English › 第 2 行',
      '小蓝灯FAQ.xlsx › 中文问答 › 第 4 行',
      '小蓝灯FAQ.xlsx › 中文问答 › 第 5 行',
    ])

    // 起草回复检索知识走的是同一个检索口（客服 / 聊天 / 随便聊 / 运行时查政策都是 `retrieval.search`，
    // 不按 subject.type 过滤）。小库走「整库注入」档、大库走关键词档——两档都要拿得到
    const lexical = async (text: string) => {
      const config = s.roles.effectiveConfig(s.bootstrap.ownerAssignment.id)
      return (
        await s.knowledge.retrieval.search({
          text,
          mode: 'lexical',
          actor: {
            person_id: s.bootstrap.person.id,
            workspace_id: s.bootstrap.workspace.id,
            assignment_id: s.bootstrap.ownerAssignment.id,
            role_id: s.bootstrap.ownerAssignment.role_id,
            grants: config.scopes,
            ranges: config.ranges,
          },
        })
      ).hits.map((h) => h.statement_redacted)
    }
    for (const [text, expected] of [
      ['充满要多久', '约 90 分钟'],
      ['waterproof', 'Splash resistant'],
    ] as const) {
      const res = await call('POST', '/v1/knowledge/search', JSON.stringify({ text }), true)
      const hits = ((await res.json()) as { data: { hits: { statement_redacted: string }[] } }).data
        .hits
      expect(hits.some((h) => h.statement_redacted.includes(expected))).toBe(true)
      expect((await lexical(text))[0]).toContain(expected)
    }

    // 改过的表：一条答案变了、删了一条 → 一张新卡写明「改 1 · 少 1」
    const v2 = structuredClone(TABLE)
    ;(v2[0] as (typeof TABLE)[number]).rows[4] = ['', '充满要多久？', '约 60 分钟（快充）。']
    ;(v2[1] as (typeof TABLE)[number]).rows.pop()
    await upload('小蓝灯FAQ.xlsx', xlsx(v2))
    const [update] = await importCards()
    const u = update?.payload as FaqImportPayload
    expect(u.counts).toMatchObject({ new: 0, changed: 1, same: 1, removed: 1 })
    expect(u.changes[0]).toEqual({
      question: '充满要多久？',
      before: '约 90 分钟。',
      after: '约 60 分钟（快充）。',
    })
    await decide(update as ApprovalItem, 'all')
    const after = {
      hits: (await lexical('充满要多久')).map((statement_redacted) => ({ statement_redacted })),
    }
    expect(after.hits.map((h) => h.statement_redacted)).toEqual([
      // 陈述进库前过外部文本清洗（全角标点归一）；原话在 structured.answer 里
      'Q: 充满要多久?\nA: 约 60 分钟(快充)。',
    ])
  })

  it('不是问答表的表格照常上传、不出卡', async () => {
    const { upload, importCards } = await boot()
    await upload('价目.xlsx', xlsx([TABLE[2] as (typeof TABLE)[number]]))
    expect(await importCards()).toHaveLength(0)
  })
})
