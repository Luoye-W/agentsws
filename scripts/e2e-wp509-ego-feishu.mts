/**
 * WP509 联调（Mac / Windows 都能跑）：**真的 ego**、**本机假飞书**——把「经 ego 往飞书表格里写」走一遍。
 *
 *   npx tsx scripts/e2e-wp509-ego-feishu.mts [--port 5099] [--ego <ego-browser 路径>] [--shots <目录>]
 *
 * - 假飞书开在 127.0.0.1:<port>（`apps/server/test/fixtures/fake-feishu.ts`）：画布表格、截住复制、原生粘贴落格、单选列、撤销；
 * - 走产品里**同一份**脚本与子进程跑法（只读通道读表头、`runEgoSheetWrite` 写），**不碰任何真网站**；
 * - 每一趟开一个新的 AI 空间，跑完 `finish({ keep: [] })` 收掉（登录页 / 没权限页同样收掉）。
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runEgoRead } from '../apps/server/src/ego-read/runner.ts'
import { runEgoSheetWrite } from '../apps/server/src/kol-sync/runner.ts'
import { syncTableOf } from '../apps/server/src/kol-sync/table.ts'
import { type FakeTable, startFakeFeishu } from '../apps/server/test/fixtures/fake-feishu.ts'

const args = process.argv.slice(2)
const val = (n: string, d?: string): string | undefined =>
  args.includes(n) ? args[args.indexOf(n) + 1] : d
const port = Number(val('--port', '5099'))
if (port === 4317) throw new Error('别用 4317')
const egoPath = val('--ego', join(homedir(), '.local/bin/ego-browser')) as string
const shots = val('--shots')
if (shots !== undefined) mkdirSync(shots, { recursive: true })

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
const JONAS = [
  'Gadget Jonas',
  'YouTube',
  'https://www.youtube.com/@gadgetjonas',
  '9000',
  '谈价中',
  '',
  '1',
]
const HANA = ['Hana Lee', 'TikTok', 'https://www.tiktok.com/@hanalee', '800', '已联系', '', '2']
const base = (over: Partial<FakeTable> = {}): FakeTable => ({
  kind: 'bitable',
  title: '工坊联调表',
  fields: FIELDS,
  rows: [JONAS.slice(), HANA.slice()],
  ...over,
})
const fake = await startFakeFeishu(
  {
    e2eBase01: base({ addButton: true }),
    e2eBlank01: base({ rows: [JONAS.slice(), HANA.slice(), ['', '', '', '', '', '', '']] }),
    e2eDrift01: base({ addButton: true, pasteDrift: 1 }),
    e2eSheet01: {
      kind: 'sheet',
      title: '工坊联调表格',
      rows: [
        ['名字', '主页', '状态'],
        ['Gadget Jonas', 'https://www.youtube.com/@gadgetjonas', '谈价中'],
      ],
    },
    e2eLogin01: base({ gate: 'login' }),
  },
  port,
)
const url = (token: string) => `${fake.origin}${fake.pathOf(token)}`
const shot = (name: string) =>
  shots === undefined ? {} : { shot: join(shots, `wp509-ego-${name}.png`) }

let failed = 0
const check = (ok: boolean, what: string, detail?: unknown) => {
  console.log(
    `${ok ? '✓' : '✗'} ${what}${ok || detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`,
  )
  if (!ok) failed += 1
}

try {
  // 1 读表头（只读通道：读页 + 截住复制）
  const read = await runEgoRead({
    egoPath,
    call: {
      url: url('e2eBase01'),
      settle_ms: 2500,
      steps: [
        { op: 'read', id: 'page' },
        { op: 'copy', id: 'copy' },
      ],
    },
  })
  const table = syncTableOf(read.steps.find((s) => s.id === 'copy')?.copied ?? [], 'bitable')
  check(
    read.state === 'ok' &&
      read.closed === true &&
      table?.header.join('|') === FIELDS.map((f) => f.name).join('|'),
    '读表头：截住复制拿到字段名、单选项（空间收掉）',
    { state: read.state, why: read.why, header: table?.header },
  )
  check(table?.columns[4]?.options?.includes('寄样中') === true, '读表头：单选列的选项读得到')

  // 2 多维表格：改一行（探认行格再写）+ 表尾没空行 → 点「添加记录」→ 追加
  const w1 = await runEgoSheetWrite({
    egoPath,
    call: {
      url: url('e2eBase01'),
      kind: 'bitable',
      key_column: '主页链接',
      settle_ms: 2500,
      ...shot('01-bitable'),
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
    },
  })
  const t1 = fake.table('e2eBase01')
  check(
    w1.state === 'ok' &&
      w1.closed === true &&
      w1.ops.map((o) => o.result).join(',') === 'updated,appended',
    '多维表格：改一行 + 点「添加记录」追加一行（原生粘贴落格）',
    { state: w1.state, why: w1.why, ops: w1.ops },
  )
  check(
    t1.rows[0]?.[4] === '寄样中' &&
      t1.rows[0]?.[5] === 'SF123' &&
      t1.rows[2]?.[0] === 'Desk Fixture',
    '假飞书里真的写进去了',
    t1.rows,
  )
  check(JSON.stringify(t1.rows[1]) === JSON.stringify(HANA), '别的行一格没动')

  // 3 表尾空行 + 认不准行 → 追加进展行
  const w2 = await runEgoSheetWrite({
    egoPath,
    call: {
      url: url('e2eBlank01'),
      kind: 'bitable',
      key_column: '主页链接',
      settle_ms: 2500,
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
    },
  })
  check(
    w2.state === 'ok' && w2.ops[0]?.result === 'fallback_appended',
    '找不到那一行 → 用表尾空行追加一行进展记录',
    w2.ops,
  )

  // 4 电子表格
  const w3 = await runEgoSheetWrite({
    egoPath,
    call: {
      url: url('e2eSheet01'),
      kind: 'sheet',
      key_column: '主页',
      settle_ms: 2500,
      ...shot('02-sheet'),
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
    },
  })
  check(
    w3.state === 'ok' &&
      fake.table('e2eSheet01').rows[1]?.[2] === '已寄样' &&
      fake.table('e2eSheet01').rows[2]?.[0] === 'Desk Fixture',
    '电子表格：改一格 + 追加一行',
    { state: w3.state, why: w3.why, rows: fake.table('e2eSheet01').rows.slice(0, 3) },
  )

  // 5 粘歪了 → 全撤
  const before = JSON.stringify(fake.table('e2eDrift01').rows)
  const w4 = await runEgoSheetWrite({
    egoPath,
    call: {
      url: url('e2eDrift01'),
      kind: 'bitable',
      key_column: '主页链接',
      settle_ms: 2500,
      ops: [
        {
          id: 'u1',
          op: 'update',
          key_text: 'https://www.tiktok.com/@hanalee',
          cells: { 红人: 'Hana L.' },
        },
      ],
    },
  })
  check(
    w4.state === 'rolled_back' && JSON.stringify(fake.table('e2eDrift01').rows) === before,
    '粘歪了 → ControlOrMeta+Z 全撤、表格恢复原样',
    { state: w4.state, why: w4.why },
  )

  // 6 登录页
  const w5 = await runEgoSheetWrite({
    egoPath,
    call: { url: url('e2eLogin01'), kind: 'bitable', settle_ms: 1500, ops: [] },
  })
  check(w5.state === 'login' && w5.closed === true, '登录页：照实回 login、空间收掉', {
    state: w5.state,
  })
} finally {
  await fake.close()
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条没过`)
process.exit(failed === 0 ? 0 : 1)
