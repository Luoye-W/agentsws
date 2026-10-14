#!/usr/bin/env node
/**
 * WP322（docs/102 §5.4，决策 670）：FAQ 表导入的截图（可重跑）。
 *
 * 在本进程里起一个服务进程（临时数据目录——上传要对象存储，内存档不收；跑完删掉），托管工作台构建产物，
 * 不联网、不接 AI、不碰 4317。一个人用（①）：
 *
 * 1. `1-faq-import-card`：传一份假的 FAQ 表（两张工作表、表头不在第一行、合并的分类）→ 首页那张定规矩卡；
 * 2. `2-knowledge-faq`：点「记下」之后知识库里那几张卡（出处 文件 › 表 › 行）；
 * 3. `3-faq-update-card`：再传一份改过的表（一条答案变了、删了一条）→ 那张写着「改 1 · 表里少了 1」的卡。
 *
 * 表里全是现编的假问答，不放任何真实客户数据。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp322-shots.mjs [--port 4422]
 * ```
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp322')
mkdirSync(SHOTS, { recursive: true })

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4422')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'lan@bluelamp.example'

const { createServer } = await import(join(ROOT, 'apps/server/dist/index.js'))
const { zipFiles } = await import(join(ROOT, 'packages/knowledge/dist/index.js'))

const dataDir = mkdtempSync(join(tmpdir(), 'agentsws-wp322-shots-'))
const server = await createServer({
  quiet: true,
  startRun: false,
  tokenRefreshIntervalMs: 0,
  scheduleIntervalMs: 0,
  port: PORT,
  dbDir: dataDir,
  staticDir: join(ROOT, 'apps/workstation/dist'),
  env: { AGENTSWS_OWNER_EMAIL: OWNER },
  mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
})

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** 一份最小的真 xlsx（行内字串 + 合并格）。 */
function xlsx(sheets) {
  const col = (c) => String.fromCharCode(65 + c)
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

const V1 = [
  {
    name: '中文问答',
    rows: [
      ['小蓝灯常见问题', '小蓝灯常见问题', '小蓝灯常见问题'],
      ['', '', ''],
      ['问题分类', '客户常见问题', '标准回复话术'],
      ['续航', '充一次电能用多久？', '正常亮度约 6 小时，省电模式约 10 小时。'],
      ['', '充满要多久？', '约 90 分钟，灯圈变绿就是满了。'],
      ['配送', '寄到加拿大要几天？', '一般 7–10 个工作日。'],
    ],
    merges: ['A1:C1', 'A4:A5'],
  },
  {
    name: 'English',
    rows: [
      ['Question', 'Answer (EN)', 'Lang'],
      ['Is it waterproof?', 'Splash resistant only — please do not submerge it.', 'en'],
      ['Can kids use it?', 'Yes, with an adult around.', 'en'],
    ],
  },
]

const call = async (method, path, body) => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (body !== undefined && !(body instanceof FormData))
    headers.set('content-type', 'application/json')
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    }),
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}
const post = async (path, body) =>
  (
    await (
      await server.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    ).json()
  ).data
const upload = async (name, bytes) => {
  const fd = new FormData()
  fd.set('file', new Blob([bytes]), name)
  await call('POST', '/v1/knowledge/sources/upload', fd)
  await server.faqImport.settled()
}
const importCard = async () =>
  (
    await server.txn.approvals.queue({
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      lane: 'mine',
    })
  ).find((i) => i.payload?.form === 'faq_import')

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  await server.listen(PORT)
  await call('PUT', '/v1/workspace/profile', {
    legal_name: '小蓝灯科技（示例）',
    brand_name: 'BlueLamp',
    discoverable: false,
  })
  await server.identity.renamePerson(server.bootstrap.person.id, '蓝蓝')
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  const token = (await post('/v1/auth/verify', { token: link.token })).session_token

  const browser = await chromium.launch({ headless: true })
  const open = async (path) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
        window.localStorage.setItem('agentsws.theme', 'light')
      } catch {
        /* 写不进去就算了 */
      }
    }, token)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    return page
  }
  const shotCard = async (name, text) => {
    const page = await open('/')
    const card = page.locator('[data-testid="deck-card"]', { hasText: text }).first()
    await card.waitFor({ timeout: 30_000 })
    await card.scrollIntoViewIfNeeded().catch(() => undefined)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, `${name}.png`) })
    console.log(`  ✓ ${name}.png`)
    await page.context().close()
  }
  const decide = async (item, option) => {
    await call('POST', `/v1/approvals/${item.id}/decide`, {
      action: 'approve',
      selected_option_id: option,
    })
    await server.faqImport.settled()
  }
  try {
    await upload('小蓝灯FAQ.xlsx', xlsx(V1))
    await shotCard('1-faq-import-card', '导入')
    await decide(await importCard(), 'all')
    {
      const page = await open('/knowledge')
      await page.getByText('寄到加拿大要几天').first().waitFor({ timeout: 30_000 })
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, '2-knowledge-faq.png') })
      console.log('  ✓ 2-knowledge-faq.png')
      await page.context().close()
    }
    const v2 = structuredClone(V1)
    v2[0].rows[4] = ['', '充满要多久？', '约 60 分钟（支持快充），灯圈变绿就是满了。']
    v2[1].rows.pop()
    await upload('小蓝灯FAQ.xlsx', xlsx(v2))
    await shotCard('3-faq-update-card', '导入')
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  await server.close()
  rmSync(dataDir, { recursive: true, force: true })
}
