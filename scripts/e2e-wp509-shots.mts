/**
 * WP509：红人同步到飞书表的界面——中栏「同步设置」卡、第三栏「连接」里的同步那一行（点开）、红人库 ⋯ 叠开的那一层，
 * 浅 / 深各拍一套；再拍一张同步之后的假飞书表（证据）。
 *
 * 不联网、不接真 AI、不碰 4317、**不碰真的 ego、不碰真飞书**：demo（真服务进程 + 演示世界 + stub）里注入一个假 ego
 * （进程内 Playwright，跑产品里同一份读表 / 写表脚本），页面是本机假飞书（127.0.0.1）。
 *
 * ```
 * npx tsc -b && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * npx tsx scripts/e2e-wp509-shots.mts --port 5098 --feishu 5099 --out <目录>
 * ```
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runEgoRead } from '../apps/server/src/ego-read/runner.ts'
import { runEgoSheetWrite } from '../apps/server/src/kol-sync/runner.ts'
import { launchChromium, playwrightEgo } from '../apps/server/test/fixtures/fake-ego-playwright.ts'
import { startFakeFeishu } from '../apps/server/test/fixtures/fake-feishu.ts'

const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const argOf = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '5098')
const FEISHU = Number(argOf('--feishu') ?? '5099')
const OUT = resolve(argOf('--out') ?? join(ROOT, 'tmp/wp509'))
if (PORT === 4317 || FEISHU === 4317) throw new Error('别用 4317')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const TABLE_URL = 'https://nordvolt.feishu.cn/base/ShotBase001?table=tbl1'

let failed = false
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? '✅' : '❌'} ${what}`)
  if (!ok) failed = true
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  asg?: string,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(asg === undefined ? {} : { 'x-assignment': asg }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json().catch(() => ({}))) as { data: T; message?: string }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const fake = await startFakeFeishu(
    {
      ShotBase001: {
        kind: 'bitable',
        title: 'Nordvolt 红人合作表',
        fields: [
          { name: '红人', type: 1 },
          { name: '平台', type: 3, options: ['YouTube', 'TikTok', 'Instagram'] },
          { name: '主页链接', type: 15 },
          { name: '粉丝', type: 2 },
          {
            name: '合作状态',
            type: 3,
            options: ['待联系', '已发邮件', '谈价中', '寄样中', '已发布', '不合作'],
          },
          { name: '快递单号', type: 1 },
          { name: '负责人', type: 11 },
          { name: '备注', type: 1 },
        ],
        rows: [
          [
            'Gadget Jonas',
            'YouTube',
            'https://www.youtube.com/@gadgetjonas',
            '91000',
            '谈价中',
            '',
            '阿林',
            '老朋友',
          ],
          [
            'Hana Lee',
            'TikTok',
            'https://www.tiktok.com/@hanalee',
            '8000',
            '已发邮件',
            '',
            '阿林',
            '',
          ],
        ],
        addButton: true,
      },
    },
    FEISHU,
  )
  const browser = await launchChromium(ROOT)
  const pw = playwrightEgo(browser, {
    rewrite: (u) => {
      const url = new URL(u)
      return `${fake.origin}${url.pathname}${url.search}`
    },
  })
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    kolSheetEgo: {
      available: () => true,
      read: (c: never) => runEgoRead({ egoPath: '/fake/ego', call: c, spawn: pw.spawn }),
      write: (c: never) => runEgoSheetWrite({ egoPath: '/fake/ego', call: c, spawn: pw.spawn }),
    },
  })
  await demo.server.listen()
  try {
    const server = demo.server
    const ws = server.bootstrap.workspace.id
    const person_id = server.bootstrap.person.id
    const link = await call<{ token: string }>('POST', '/v1/auth/magic-link', { email: OWNER })
    const owner = (
      await call<{ session_token: string }>('POST', '/v1/auth/verify', { token: link.token })
    ).session_token
    const kolAsg = server.roles.assignments
      .listByPerson(person_id, { workspace_id: ws })
      .find(
        (a: { role_id: string; revoked_at?: string }) =>
          a.role_id === 'kol.youtube' && a.revoked_at === undefined,
      )
    if (kolAsg === undefined) throw new Error('演示世界里没有红人营销（YouTube）')
    const brand = await server.brands.forWorkspace(ws)
    const now = new Date().toISOString()
    const seed = (
      id: string,
      name: string,
      handle: string,
      followers: number,
      stage: string,
      extra = {},
    ) => {
      brand.kol.saveCreator({ id, display_name: name, merged_from: [] })
      brand.kol.saveAccount({
        id: `pa_${id}`,
        creator_id: id,
        channel: 'youtube',
        handle,
        url: `https://www.youtube.com/@${handle}`,
        followers,
        observed_at: now,
      })
      brand.kol.saveCollaboration({
        id: `col_${id}`,
        creator_id: id,
        channel: 'youtube',
        stage,
        currency: 'USD',
        stage_changed_at: now,
        last_activity_at: now,
        ...extra,
      })
    }
    seed('cre_shot_jonas', 'Gadget Jonas', 'gadgetjonas', 91000, 'sample_sent', {
      sample: {
        address_ref: 'x',
        address_masked: 'Berlin, DE · J***',
        tracking_no: 'SF1234567',
        currency: 'USD',
        shipped_at: now,
      },
    })
    seed('cre_shot_desk', 'Desk Fixture', 'deskfixture', 48000, 'contacted')
    seed('cre_shot_rosa', 'Rosa Desk', 'rosadesk', 23000, 'closed')
    const sync = brand.kolSheetSync
    if (sync === undefined) throw new Error('demo 里没装红人同步')
    const actor = { workspace_id: ws, person_id, assignment_id: kolAsg.id, role_id: 'kol.youtube' }
    const got = await sync.propose(actor, {
      url: TABLE_URL,
      instruction: `把红人同步到我这张飞书表 ${TABLE_URL}`,
    })
    check(got.ok, `读表头、出同步设置卡：${got.message}`)

    for (const theme of (process.env.WP509_ONLY_DECIDE === '1' ? [] : ['light', 'dark']) as (
      | 'light'
      | 'dark'
    )[]) {
      const context = await (
        browser as never as {
          newContext(o: unknown): Promise<{
            addInitScript(fn: unknown, arg: unknown): Promise<void>
            newPage(): Promise<import('playwright').Page>
            close(): Promise<void>
          }>
        }
      ).newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
        timezoneId: 'Asia/Shanghai',
      })
      await context.addInitScript(
        ([t, th]: [string, string]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {}
        },
        [owner, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/positions/${kolAsg.id}`, { waitUntil: 'load', timeout: 90_000 })
      const cardBody = page.getByTestId('deck-kol-sync').first()
      await cardBody.waitFor({ timeout: 60_000 })
      await page.waitForTimeout(1500)
      await cardBody.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(OUT, `${theme}-1-sync-card.png`) })
      console.log(`  📷 ${theme}-1-sync-card.png`)
      check((await page.getByTestId('kol-sync-column').count()) === 8, `[${theme}] 卡上 8 列都在`)
      await context.close()
    }

    // 点「开始同步」（卡上「已结案」对成「已发布」）
    const card = await server.approvals.get(got.card_id as string)
    await call(
      'POST',
      `/v1/approvals/${got.card_id}/decide`,
      {
        action: 'approve',
        via: 'workstation',
        edited_payload: {
          ...(card?.payload as object),
          stage_map: [
            { stage: 'contacted', option: '已发邮件' },
            { stage: 'closed', option: '已发布' },
          ],
        },
      },
      owner,
      kolAsg.id,
    )
    for (let i = 0; i < 120; i += 1) {
      const list = await call<{ syncs: { last_ok_at?: string }[] }>(
        'GET',
        '/v1/kol/sync',
        undefined,
        owner,
        kolAsg.id,
      )
      if (list.syncs[0]?.last_ok_at !== undefined) break
      await new Promise((r) => setTimeout(r, 500))
    }
    const decidedCard = await server.approvals.get(got.card_id as string)
    console.log(
      '  · 卡',
      decidedCard?.state,
      JSON.stringify(
        (decidedCard?.decision as { edited_payload?: { stage_map?: unknown } } | undefined)
          ?.edited_payload?.stage_map,
      ),
    )
    const sinkNow = brand.kolSheetSync?.list().syncs[0]
    const log = sinkNow === undefined ? undefined : brand.kolSheetSync?.log(sinkNow.id)
    console.log(
      '  · 留痕',
      JSON.stringify(
        log?.rows[0]?.items.map((i: { name: string; cells: unknown; result: string }) => [
          i.name,
          i.result,
          i.cells,
        ]),
      ),
    )
    const rows = fake.table('ShotBase001').rows
    check(
      rows[0]?.[4] === '寄样中' && rows[0]?.[5] === 'SF1234567',
      `Jonas 那一行改成寄样中 + 单号（${rows[0]?.join(' | ')}）`,
    )
    check(
      rows.some((r) => r[0] === 'Desk Fixture' && r[4] === '已发邮件'),
      '新红人追加一行（阶段对成卡上选的「已发邮件」）',
    )
    check(rows[0]?.[6] === '阿林' && rows[0]?.[7] === '老朋友', '负责人 / 备注两格没动')

    for (const theme of ['light', 'dark'] as const) {
      const context = await (
        browser as never as {
          newContext(o: unknown): Promise<{
            addInitScript(fn: unknown, arg: unknown): Promise<void>
            newPage(): Promise<import('playwright').Page>
            close(): Promise<void>
          }>
        }
      ).newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
        timezoneId: 'Asia/Shanghai',
      })
      await context.addInitScript(
        ([t, th]: [string, string]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {}
        },
        [owner, theme],
      )
      const page = await context.newPage()
      await page.goto(`${BASE}/positions/${kolAsg.id}?panel=connections`, {
        waitUntil: 'load',
        timeout: 90_000,
      })
      const row = page.getByTestId('kol-sync-row').first()
      await row.waitFor({ timeout: 60_000 })
      await row.locator('button').first().click()
      await page.getByTestId('kol-sync-log').waitFor({ timeout: 20_000 })
      await page.waitForTimeout(1200)
      await page.screenshot({ path: join(OUT, `${theme}-2-rail-connections.png`) })
      console.log(`  📷 ${theme}-2-rail-connections.png`)
      // 红人库 ⋯ →「同步到表格」
      await page.goto(`${BASE}/positions/${kolAsg.id}?panel=kol-library`, {
        waitUntil: 'load',
        timeout: 90_000,
      })
      await page.getByTestId('kol-library').waitFor({ timeout: 60_000 })
      const more = page.getByTestId('library-menu').first()
      if ((await more.count()) > 0) {
        await more.click()
        await page.getByTestId('library-menu-sync').click()
        await page.getByTestId('kol-sync-detail').waitFor({ timeout: 20_000 })
        await page.waitForTimeout(1000)
        await page.screenshot({ path: join(OUT, `${theme}-3-kol-library-sync.png`) })
        console.log(`  📷 ${theme}-3-kol-library-sync.png`)
      } else check(false, `[${theme}] 红人库头上没找到 ⋯`)
      await context.close()
    }
    // 同步之后的假飞书表（证据）
    const ctx = await (
      browser as never as {
        newContext(
          o: unknown,
        ): Promise<{ newPage(): Promise<import('playwright').Page>; close(): Promise<void> }>
      }
    ).newContext({ viewport: { width: 1100, height: 420 }, deviceScaleFactor: 2 })
    const p = await ctx.newPage()
    await p.goto(`${fake.origin}${fake.pathOf('ShotBase001')}`)
    await p.waitForTimeout(500)
    await p.screenshot({ path: join(OUT, 'light-4-fake-feishu-after.png') })
    await ctx.close()
  } finally {
    await demo.close()
    await browser.close()
    await fake.close()
  }
}

main().then(
  () => process.exit(failed ? 1 : 0),
  (e) => {
    console.error(e)
    process.exit(2)
  },
)
