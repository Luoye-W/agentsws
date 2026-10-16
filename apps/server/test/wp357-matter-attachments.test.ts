/**
 * WP357（Luoye 10-16 真机：把 Excel 拖进「Reddit 运营」岗位页的输入框没反应）——岗位页与事项 / 线程输入框能附资料。
 *
 * 真装配线（路由 → 网关校验 → positions.ts / work 端口 → 工作模型），`startRun` 换成记账的替身：
 * 它收到的 `brief` 就是运行拿到的输入。钉住：
 * - 岗位入口附一份 xlsx → 事项第一句话上记着附件（表格读成「一行一行、格子用 | 隔开」，看得出表头和列），
 *   运行输入 = 话 + 附件围起来；换职责重跑时附件也带上；
 * - 事项 / 线程里只附一份 docx、不说话 → 时间线记一句「看一下附上的资料」，运行拿到 docx 的文字；
 *   不是从岗位开的事项（`POST /v1/matters`）同样；
 * - 读不出的（.xls、坏文件）照实说；什么都没说也没附 → 400。
 * 夹具全是现编的假数据。
 */

import type { Assignment, Matter, MatterEvent } from '@agentsws/contracts'
import { EXTERNAL_FENCE } from '@agentsws/core'
import { zipFiles } from '@agentsws/knowledge'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-16T01:00:00.000Z'
const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64')
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

/** 最小的 xlsx（一张表，行内字串）。 */
function xlsx(name: string, rows: string[][]): Buffer {
  const col = (c: number): string => String.fromCharCode(65 + c)
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row
          .map(
            (v, c) =>
              `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`,
          )
          .join('')}</row>`,
    )
    .join('')}</sheetData></worksheet>`
  return zipFiles([
    { path: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
    {
      path: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    { path: 'xl/worksheets/sheet1.xml', content: sheet },
  ])
}

const docx = (lines: string[]): Buffer =>
  zipFiles([
    {
      path: 'word/document.xml',
      content: `<w:document><w:body>${lines.map((l) => `<w:p><w:r><w:t>${esc(l)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
    },
  ])

const SHEET = xlsx('帖子记录', [
  ['日期', '帖子链接', '版块', '负责人', '状态'],
  ['10-14', 'https://example.com/r/1', 'r/headphones', '小李', '已发'],
  ['10-15', 'https://example.com/r/2', 'r/audiophile', '小王', '草稿'],
])

let server: Server
const briefs: { matter: Matter; brief: string; assignment_id: string }[] = []
const held = new Map<string, Assignment>()

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', options.assignment ?? server.bootstrap.ownerAssignment.id)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

const json = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

const said = (matter_id: string): MatterEvent[] =>
  server.work.store.listMatterEvents(matter_id).filter((e) => e.kind === 'human_message')

beforeEach(async () => {
  briefs.length = 0
  let t = Date.parse(T0)
  server = await createServer({
    clock: {
      now: () => {
        t += 1
        return new Date(t).toISOString()
      },
    },
    random: () => 0.5,
    quiet: true,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    startRun: (input) => {
      briefs.push({
        matter: input.matter,
        brief: input.brief,
        assignment_id: input.actor.assignment_id,
      })
      return { run_id: `run_${briefs.length}` }
    },
  })
  held.clear()
  for (const role_id of ['dtc.store', 'dtc.content']) {
    held.set(
      role_id,
      server.roles.assignments.create({
        person_id: server.bootstrap.person.id,
        workspace_id: server.bootstrap.workspace.id,
        role_id,
        granted_by: server.bootstrap.person.id,
        ranges: [{ kind: 'store', id: 'store_1' }],
      }),
    )
  }
})

afterEach(async () => {
  await server.close()
})

describe('WP357 岗位页输入框附资料', () => {
  it('附一份 xlsx → 事项第一句话带着表格文字（看得出表头和列），运行输入 = 话 + 附件', async () => {
    const res = await call('POST', '/v1/positions/web-ops/matters', {
      body: {
        title: '参考甲方这张表的结构，改我们自己的飞书记录表',
        mode: 'task',
        files: [{ name: '甲方记录表.xlsx', data: b64(SHEET) }],
      },
    })
    expect(res.status).toBe(201)
    const out = await json<{ matter: Matter }>(res)
    const first = said(out.matter.id)[0]
    expect(first?.text).toBe('参考甲方这张表的结构，改我们自己的飞书记录表')
    const a = first?.attachments?.[0]
    expect(a?.name).toBe('甲方记录表.xlsx')
    expect(a?.text?.split('\n')).toEqual([
      '日期 | 帖子链接 | 版块 | 负责人 | 状态',
      '10-14 | https://example.com/r/1 | r/headphones | 小李 | 已发',
      '10-15 | https://example.com/r/2 | r/audiophile | 小王 | 草稿',
    ])
    // 运行拿到的：话在前，附件当外部资料围起来
    expect(briefs).toHaveLength(1)
    const brief = briefs[0]?.brief ?? ''
    expect(brief.startsWith('参考甲方这张表的结构，改我们自己的飞书记录表')).toBe(true)
    expect(brief).toContain('附件「甲方记录表.xlsx」')
    expect(brief).toContain(EXTERNAL_FENCE.open)
    expect(brief).toContain('日期 | 帖子链接 | 版块 | 负责人 | 状态')
    // 事项标题不被附件撑长
    expect(out.matter.title).not.toContain('日期')

    // 换一条职责重跑：附件跟着进新的那次运行
    const rr = await call('POST', `/v1/matters/${out.matter.id}/reroute`, {
      body: { role_id: 'dtc.content', run: true },
    })
    expect(rr.status).toBe(200)
    expect(briefs.at(-1)?.brief).toContain('日期 | 帖子链接 | 版块 | 负责人 | 状态')
  })

  it('读不出的照实说：.xls 不收、坏的 xlsx 读不了，运行里写明读不出', async () => {
    const res = await call('POST', '/v1/positions/web-ops/matters', {
      body: {
        title: '看看这两份表',
        mode: 'task',
        files: [
          { name: '老表.xls', data: b64('x') },
          { name: '坏.xlsx', data: b64('not a zip') },
        ],
      },
    })
    expect(res.status).toBe(201)
    const out = await json<{ matter: Matter }>(res)
    const list = said(out.matter.id)[0]?.attachments ?? []
    expect(list.map((x) => x.text)).toEqual([undefined, undefined])
    expect(list[0]?.unreadable).toMatch(/\.xlsx/u)
    expect(list[1]?.unreadable).toMatch(/表格读不了/u)
    expect(briefs[0]?.brief).toContain('附件「老表.xls」：读不出文字')
  })
})

describe('WP357 事项 / 线程输入框附资料', () => {
  it('从岗位开的事项里只附一份 docx、不说话 → 时间线记一句，运行拿到 docx 的文字', async () => {
    const opened = await json<{ matter: Matter }>(
      await call('POST', '/v1/positions/web-ops/matters', {
        body: { title: '整理一版新品帖子', mode: 'task' },
      }),
    )
    const res = await call('POST', `/v1/matters/${opened.matter.id}/messages`, {
      body: {
        text: '',
        files: [{ name: '甲方要求.docx', data: b64(docx(['帖子要带价格', '每周三更新'])) }],
      },
    })
    expect(res.status).toBe(201)
    const last = said(opened.matter.id).at(-1)
    expect(last?.text).toBe('看一下附上的资料：「甲方要求.docx」')
    expect(last?.attachments?.[0]?.text).toContain('帖子要带价格')
    const brief = briefs.at(-1)?.brief ?? ''
    expect(brief).toContain('附件「甲方要求.docx」')
    expect(brief).toContain('每周三更新')
  })

  it('不是从岗位开的事项（用这条职责开）也一样；说了话也附了资料，两样都进运行', async () => {
    const opened = await json<{ matter: Matter }>(
      await call('POST', '/v1/matters', {
        body: { kind: 'adhoc', title: '核对一下 banner 文案' },
        assignment: held.get('dtc.store')?.id,
      }),
    )
    const res = await call('POST', `/v1/matters/${opened.matter.id}/messages`, {
      body: {
        text: '照这份改',
        files: [{ name: '文案.csv', data: b64('位置,文案\n首屏,秋季上新') }],
      },
      assignment: held.get('dtc.store')?.id,
    })
    expect(res.status).toBe(201)
    const last = said(opened.matter.id).at(-1)
    expect(last?.text).toBe('照这份改')
    expect(last?.attachments?.[0]?.text).toBe('位置 | 文案\n首屏 | 秋季上新')
    const brief = briefs.at(-1)?.brief ?? ''
    expect(brief.startsWith('照这份改')).toBe(true)
    expect(brief).toContain('首屏 | 秋季上新')
  })

  it('什么都没说也没附 → 400；只说话不附照旧', async () => {
    const opened = await json<{ matter: Matter }>(
      await call('POST', '/v1/matters', {
        body: { kind: 'adhoc', title: '随便一件事' },
        assignment: held.get('dtc.store')?.id,
      }),
    )
    const empty = await call('POST', `/v1/matters/${opened.matter.id}/messages`, {
      body: { text: '  ' },
      assignment: held.get('dtc.store')?.id,
    })
    expect(empty.status).toBe(400)
    const plain = await call('POST', `/v1/matters/${opened.matter.id}/messages`, {
      body: { text: '开始吧' },
      assignment: held.get('dtc.store')?.id,
    })
    expect(plain.status).toBe(201)
    expect(said(opened.matter.id).at(-1)?.attachments).toBeUndefined()
    expect(briefs.at(-1)?.brief).toBe('开始吧')
  })
})
