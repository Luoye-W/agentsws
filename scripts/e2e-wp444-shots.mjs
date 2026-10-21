#!/usr/bin/env node
/**
 * WP444（决策 1377–1381）：团队通道做成增值服务——端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起两样（跑完即停）：
 * - 团队通道的云端替身（`team-relay.ts`，`subscriptions: 'required'` = 照真云：没开通申请通道 402），端口 `--relay-port`（默认 4653）；
 * - 一个 demo（真服务进程 + 演示世界 + stub 运行时），端口 `--port`（默认 4652），`AGENTSWS_TEAM_CLOUD_URL` 指到替身。
 *
 * 用 Playwright 查：「和同事一起用」跨网那一行写「没开通」+「开通（7 天免费试用）」→ 点了就地弹小卡（每月多少积分、含几人）→
 * 确认 → 「试用中，剩 7 天」、通道接上；账号与积分里「团队通道」那张卡；替身把这个组织拨成到期 → 同事打开通道地址
 * 看到「未开通 / 已到期」。不通过就退出码 1。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓），浅 / 深各一套：
 * 1-row-none、2-confirm、3-row-trial、4-card-trial（同事看到的「未开通 / 已到期」那一页在真云里，这里只核替身那一页的字）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp444-shots.mjs [--port 4652] [--relay-port 4653] [--out <目录>]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp444'))
const PORT = Number(argOf('--port') ?? '4652') || 4652
const RELAY_PORT = Number(argOf('--relay-port') ?? '4653') || 4653
if (PORT === 4317 || RELAY_PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const DEV_TOKEN = 'wst_demo_wp444_owner'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

const shot = async (page, name, target) => {
  await page.waitForTimeout(800)
  await (target ?? page).screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
}

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { startTeamRelayStandIn } = await import(
    pathToFileURL(join(ROOT, 'apps/server/dist/team-relay.js')).href
  )
  const relay = await startTeamRelayStandIn({ port: RELAY_PORT, subscriptions: 'required' })
  process.env.AGENTSWS_TEAM_CLOUD_URL = relay.base
  process.env.AGENTSWS_TEAM_DEV_TOKEN = DEV_TOKEN
  // 局域网那扇门不开（截图不需要，也不在 4652–4655 之外再占端口）
  process.env.AGENTSWS_TEAM_LAN = 'off'
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-21T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const link = await api(undefined, undefined, 'POST', '/v1/auth/magic-link', { email: OWNER })
    const token = (
      await api(undefined, undefined, 'POST', '/v1/auth/verify', { token: link.token })
    ).session_token
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id

    let teamLink = await api(token, owner, 'GET', '/v1/team/link')
    for (let i = 0; i < 40 && teamLink.cloud.state !== 'needs_subscription'; i += 1) {
      await sleep(250)
      teamLink = await api(token, owner, 'GET', '/v1/team/link')
    }
    check(teamLink.open === true, `团队通道开着（${JSON.stringify(teamLink.cloud)}）`)
    check(teamLink.cloud.state === 'needs_subscription', '没开通：跨网那条路停在「没开通」')
    const sub0 = await api(token, owner, 'GET', '/v1/team/subscription')
    check(sub0.subscription?.status === 'none', '订阅：没开通')

    const open = async (theme) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 860 },
        deviceScaleFactor: 2,
        colorScheme: theme,
      })
      await context.addInitScript(
        ([t, th]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [token, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }

    /**
     * 「和同事一起用」那一块：① 个人在设置 →「个人与团队」里点「换成这个」就地展开；② 在设置 →「同事」、③ 在「邀请同事」
     * （演示世界是 ② 同事互联，在「同事」那一页）。
     */
    const teamBlock = async (page) => {
      await page.goto(`${BASE}/settings/mode`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      await page.getByTestId('settings-usage-mode').waitFor({ timeout: 90_000 })
      const mode = await page.getByTestId('settings-usage-mode').getAttribute('data-mode')
      if (mode === 'solo') {
        const peers = page.locator('[data-testid="mode-card"][data-mode="peers"]')
        await peers.getByTestId('mode-switch').click()
      } else {
        // ② 同事互联：「同事」那一页；③ 公司：「邀请同事」那一页
        await page.goto(`${BASE}/settings/${mode === 'peers' ? 'people' : 'invite'}`, {
          waitUntil: 'domcontentloaded',
          timeout: 90_000,
        })
      }
      const row = page.getByTestId('team-link-cloud')
      await row.waitFor({ timeout: 60_000 }).catch(async (err) => {
        await page.screenshot({ path: join(SHOTS, `debug-${mode}.png`) })
        console.error(`  ⚠️ 没找到跨网那一行（模式 ${mode}，地址 ${page.url()}）`)
        throw err
      })
      return page.getByTestId('invite-section')
    }

    // 先深色（只看、不开通），再浅色（看完点确认开通）
    for (const theme of ['dark', 'light']) {
      const { context, page } = await open(theme)
      const block = await teamBlock(page)
      const row = page.getByTestId('team-link-cloud')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="team-sub-open-button"]') !== null,
        undefined,
        { timeout: 60_000 },
      )
      const text = await row.innerText()
      if (theme === 'dark') {
        check(text.includes('没开通'), `跨网那一行写「没开通」（${text}）`)
        check(text.includes('开通（7 天免费试用）'), '有「开通（7 天免费试用）」')
      }
      await shot(page, `1-row-none-${theme}`, block)
      await page.getByTestId('team-sub-open-button').click()
      const card = page.getByTestId('team-sub-confirm')
      await card.waitFor({ timeout: 10_000 })
      if (theme === 'dark') {
        const said = await card.innerText()
        check(/积分 \/ 月 · 含 \d+ 人/.test(said), `小卡写清每月多少积分、含几人（${said}）`)
      }
      await shot(page, `2-confirm-${theme}`, block)
      if (theme === 'light') {
        await page.getByTestId('team-sub-confirm-yes').click()
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="team-link-cloud"]')
              ?.textContent?.includes('试用中') === true,
          undefined,
          { timeout: 60_000 },
        )
        check(true, '确认后：「试用中，剩 7 天」')
      }
      await context.close()
    }

    // 开通之后：通道接上
    for (let i = 0; i < 40; i += 1) {
      teamLink = await api(token, owner, 'GET', '/v1/team/link')
      if (teamLink.cloud.state === 'online') break
      await sleep(250)
    }
    check(teamLink.cloud.state === 'online', `开通后跨网那条路接上（${teamLink.cloud.state}）`)

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      const block = await teamBlock(page)
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="team-link-cloud"]')
            ?.textContent?.includes('试用中') === true,
        undefined,
        { timeout: 60_000 },
      )
      await shot(page, `3-row-trial-${theme}`, block)
      await page.goto(`${BASE}/settings/account`, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      })
      const card = page.getByTestId('team-channel-card')
      await card.waitFor({ timeout: 90_000 })
      await card.scrollIntoViewIfNeeded()
      if (theme === 'light') {
        const state = await page.getByTestId('team-channel-state').innerText()
        check(state === '试用中', `账号与积分里那张卡：试用中（${state}）`)
      }
      await shot(page, `4-card-trial-${theme}`, card)
      await context.close()
    }

    // 到期：同事打开通道地址看到「未开通 / 已到期」
    relay.setSubscription(DEV_TOKEN, 'suspended')
    const url = teamLink.cloud.url ?? teamLink.invite_base
    {
      const { context, page } = await open('light')
      const res = await page.goto(`${url}/`, { waitUntil: 'load' })
      check(res?.status() === 503, `到期后同事打开通道地址 503（${res?.status()}）`)
      check(
        (await page.content()).includes('未开通或已到期'),
        '同事看到「对方的团队通道未开通 / 已到期」',
      )
      // 截图拍的是真云那一页（私有云 `TEAM_SUBSCRIPTION_OFF_HTML`）；替身这一页只核文字
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
    await relay.close()
  }
}

main()
  .then(() => {
    process.exit(failed ? 1 : 0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
