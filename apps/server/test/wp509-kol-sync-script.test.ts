/**
 * WP509：「在 ego 里往飞书表格写」那一段脚本——**真跑**：脚本放进进程内的假 ego（Playwright 无头 Chromium），
 * 页面是本机假飞书（canvas 表格、截住复制、粘贴落格、单选列、撤销）。不起真 ego、不联网、不碰真飞书。
 */
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runEgoSheetWrite } from '../src/kol-sync/runner.js'
import { EGO_SHEET_KEYS, egoSheetScript } from '../src/kol-sync/script.js'
import { launchChromium, playwrightEgo } from './fixtures/fake-ego-playwright.js'
import { type FakeFeishu, type FakeTable, startFakeFeishu } from './fixtures/fake-feishu.js'

const ROOT = resolve(import.meta.dirname, '../../..')

const FIELDS = [
  { name: '红人', type: 1 },
  { name: '平台', type: 3, options: ['YouTube', 'TikTok'] },
  { name: '主页链接', type: 15 },
  { name: '粉丝', type: 2 },
  {
    name: '合作状态',
    type: 3,
    options: ['待联系', '已联系', '谈价中', '寄样中', '已发布', '拒绝'],
  },
  { name: '快递单号', type: 1 },
  { name: '编号', type: 20 },
]
const ROW_JONAS = [
  'Gadget Jonas',
  'YouTube',
  'https://www.youtube.com/@gadgetjonas',
  '9000',
  '谈价中',
  '',
  '1',
]
const ROW_HANA = ['Hana Lee', 'TikTok', 'https://www.tiktok.com/@hanalee', '800', '已联系', '', '2']

const bitable = (over: Partial<FakeTable> = {}): FakeTable => ({
  kind: 'bitable',
  title: '红人合作表',
  fields: FIELDS,
  rows: [ROW_JONAS.slice(), ROW_HANA.slice()],
  ...over,
})

let browser: Awaited<ReturnType<typeof launchChromium>>
let fake: FakeFeishu

beforeAll(async () => {
  browser = await launchChromium(ROOT)
  fake = await startFakeFeishu({
    btnBase: bitable({ addButton: true }),
    blankBase: bitable({
      rows: [ROW_JONAS.slice(), ROW_HANA.slice(), ['', '', '', '', '', '', '']],
    }),
    bareBase: bitable(),
    driftBase: bitable({ addButton: true, pasteDrift: 1 }),
    sheetA: {
      kind: 'sheet',
      title: '红人表',
      rows: [
        ['名字', '主页', '状态', '备注'],
        ['Gadget Jonas', 'https://www.youtube.com/@gadgetjonas', '谈价中', ''],
      ],
    },
    loginBase: bitable({ gate: 'login' }),
    noBase: bitable({ gate: 'no_access' }),
  })
}, 120_000)

afterAll(async () => {
  await fake?.close()
  await browser?.close()
})

/** 真飞书的链接 → 本机假页面（`/base/<token>`、`/sheets/<token>`）。 */
const rewrite = (u: string): string => {
  const url = new URL(u)
  return `${fake.origin}${url.pathname}${url.search}`
}
const urlOf = (token: string): string =>
  token === 'sheetA'
    ? `https://example.feishu.cn/sheets/${token}`
    : `https://example.feishu.cn/base/${token}?table=tbl1`

const run = async (
  token: string,
  call: Omit<Parameters<typeof runEgoSheetWrite>[0]['call'], 'url'>,
) => {
  const ego = playwrightEgo(browser, { rewrite })
  const res = await runEgoSheetWrite({
    egoPath: '/fake/ego-browser',
    spawn: ego.spawn,
    call: { url: urlOf(token), settle_ms: 300, ...call },
  })
  return { res, log: ego.log }
}

describe('WP509 · ego 写飞书表格的脚本（真跑，本机假页面）', () => {
  it('多维表格：按认行那一格找到行、改阶段；表尾没有空行时点「添加记录」再追加；其余格子一格不动；空间收掉', async () => {
    const { res, log } = await run('btnBase', {
      kind: 'bitable',
      key_column: '主页链接',
      ops: [
        {
          id: 'u1',
          op: 'update',
          key_text: 'https://www.youtube.com/@gadgetjonas',
          cells: { 合作状态: '寄样中', 快递单号: 'SF123' },
        },
        {
          id: 'a1',
          op: 'append',
          cells: {
            红人: 'Desk Fixture',
            平台: 'YouTube',
            主页链接: 'https://www.youtube.com/@deskfixture',
            粉丝: '48000',
            合作状态: '已联系',
          },
        },
      ],
    })
    expect(res.why ?? '').toBe('')
    expect(res.state).toBe('ok')
    expect(res.tactic).toBe('button')
    expect(res.ops.map((o) => [o.id, o.result])).toEqual([
      ['u1', 'updated'],
      ['a1', 'appended'],
    ])
    const t = fake.table('btnBase')
    expect(t.rows[0]).toEqual([
      'Gadget Jonas',
      'YouTube',
      'https://www.youtube.com/@gadgetjonas',
      '9000',
      '寄样中',
      'SF123',
      '1',
    ])
    expect(t.rows[1]).toEqual(ROW_HANA)
    expect(t.rows[2]?.slice(0, 5)).toEqual([
      'Desk Fixture',
      'YouTube',
      'https://www.youtube.com/@deskfixture',
      '48000',
      '已联系',
    ])
    // 单选项没被新建
    expect(t.fields?.[4]?.options).toEqual(FIELDS[4]?.options)
    // 只按白名单里的键；收了空间（不留页面）
    expect(log.keys.every((k) => EGO_SHEET_KEYS.includes(k))).toBe(true)
    expect(log.finished).toEqual([{ keep: [] }])
    expect(log.clicks.every((c) => c.startsWith('[data-agentsws-add="t"]'))).toBe(true)
    expect(res.after_rows?.length).toBe(3)
  }, 120_000)

  it('多维表格：先用表尾的空行；认行那一格找不到 → 退回追加一行进展记录', async () => {
    const { res } = await run('blankBase', {
      kind: 'bitable',
      key_column: '主页链接',
      ops: [
        {
          id: 'u1',
          op: 'update',
          key_text: 'https://www.youtube.com/@nobody',
          cells: { 合作状态: '已发布' },
          fallback: {
            红人: 'Nobody',
            主页链接: 'https://www.youtube.com/@nobody',
            合作状态: '已发布',
          },
        },
      ],
    })
    expect(res.state).toBe('ok')
    expect(res.tactic).toBe('blank')
    expect(res.ops[0]).toMatchObject({ result: 'fallback_appended', fallback_for: 'not_found' })
    expect(fake.table('blankBase').rows[2]?.slice(0, 5)).toEqual([
      'Nobody',
      '',
      'https://www.youtube.com/@nobody',
      '',
      '已发布',
    ])
  }, 120_000)

  it('多维表格：没有空行、也没有「添加记录」→ 照实回 no_new_row，一格不写', async () => {
    const { res } = await run('bareBase', {
      kind: 'bitable',
      key_column: '主页链接',
      ops: [
        { id: 'a1', op: 'append', cells: { 红人: 'X', 主页链接: 'https://www.youtube.com/@x' } },
      ],
    })
    expect(res.state).toBe('ok')
    expect(res.ops[0]?.result).toBe('no_new_row')
    expect(fake.table('bareBase').rows).toEqual([ROW_JONAS, ROW_HANA])
    expect(res.mutations).toBe(0)
  }, 120_000)

  it('电子表格：表头在第 1 行，数据下面本来就是空行；改一格、追加一行', async () => {
    const { res } = await run('sheetA', {
      kind: 'sheet',
      key_column: '主页',
      ops: [
        {
          id: 'u1',
          op: 'update',
          key_text: 'https://www.youtube.com/@gadgetjonas',
          cells: { 状态: '已寄样' },
        },
        {
          id: 'a1',
          op: 'append',
          cells: {
            名字: 'Desk Fixture',
            主页: 'https://www.youtube.com/@deskfixture',
            状态: '已建联',
          },
        },
      ],
    })
    expect(res.state).toBe('ok')
    expect(res.ops.map((o) => o.result)).toEqual(['updated', 'appended'])
    expect(fake.table('sheetA').rows.slice(0, 3)).toEqual([
      ['名字', '主页', '状态', '备注'],
      ['Gadget Jonas', 'https://www.youtube.com/@gadgetjonas', '已寄样', ''],
      ['Desk Fixture', 'https://www.youtube.com/@deskfixture', '已建联', ''],
    ])
  }, 120_000)

  it('粘歪了（别的格子也变了）→ 按 ControlOrMeta+Z 把这一趟全撤掉，表格恢复原样', async () => {
    const before = structuredClone(fake.table('driftBase').rows)
    const { res, log } = await run('driftBase', {
      kind: 'bitable',
      key_column: '主页链接',
      ops: [
        {
          id: 'u1',
          op: 'update',
          key_text: 'https://www.tiktok.com/@hanalee',
          cells: { 红人: 'Hana L.' },
        },
      ],
    })
    expect(res.state).toBe('rolled_back')
    expect(res.ops[0]?.result).toBe('undone')
    expect(log.keys).toContain('ControlOrMeta+Z')
    expect(fake.table('driftBase').rows).toEqual(before)
  }, 120_000)

  it('少了列 → columns_changed，一格不写；登录页 / 没权限页照实回', async () => {
    const miss = await run('btnBase', {
      kind: 'bitable',
      key_column: '主页链接',
      ops: [{ id: 'a1', op: 'append', cells: { 不存在的列: 'x' } }],
    })
    expect(miss.res.state).toBe('columns_changed')
    expect(miss.res.missing_columns).toEqual(['不存在的列'])
    expect(miss.res.mutations).toBe(0)
    expect((await run('loginBase', { kind: 'bitable', ops: [] })).res.state).toBe('login')
    expect((await run('noBase', { kind: 'bitable', ops: [] })).res.state).toBe('no_access')
  }, 120_000)

  it('脚本只按白名单的键：不打字、不 fill、不 insertText；唯一的 DOM 点击是「添加记录」', () => {
    const s = egoSheetScript({
      space: 's',
      url: 'https://x.feishu.cn/base/abcdef',
      out: '/tmp/x',
      kind: 'auto',
      ops: [],
    })
    for (const bad of [
      '.type(',
      '.fill(',
      'insertText',
      'setInputFiles',
      'selectOption',
      'acceptDialog',
    ])
      expect(s.includes(bad)).toBe(false)
    expect(s.match(/page\.click\(/gu)?.length).toBe(1)
    expect(s.match(/keyboard\.press\(/gu)?.length).toBe(1)
    expect(s).toContain('refused-key')
  })
})
