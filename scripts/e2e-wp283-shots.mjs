#!/usr/bin/env node
/**
 * WP283（决策 300）：改图「圈区域」入口按型号能力表给，截图可重跑出处。
 *
 * 起一个 demo（端口默认 4431，不碰 4317）。全替身：demo 里生图是占位图，不调真模型、不花钱。
 *
 * 1. 经 Agents 工坊积分（GPT Image 2.5 经 OpenRouter，demo 里关联的是云替身）：事项里加的图上**没有**笔刷；
 * 2. 认遮罩的型号（自己的 OpenAI key 直连 GPT Image 2.5）：图上有笔刷——demo 里没有真 OpenAI 配置（填了要联网拉清单），
 *    这一态在页面里包一层 fetch，把传图回包里的 `edit_mask` 改成 `true`（回包形状由服务端测试钉住）；
 * 3. 点笔刷 → 「圈出要改的地方」涂一笔；4. 圈好之后笔刷变蓝。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp283-shots.mjs [--port 4431]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp283')
const args = process.argv.slice(2)
const PORT = Number(args[args.indexOf('--port') + 1] ?? '4431') || 4431
if (PORT === 4317) throw new Error('4317 是本机在用的服务，换个端口')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

function startDemo() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  return { child, log }
}

async function waitForDemo(log) {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${BASE}/app/bootstrap.json`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function api(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  mkdirSync(SHOTS, { recursive: true })
  const { child, log } = startDemo()
  let browser
  const dropDir = mkdtempSync(join(tmpdir(), 'wp283-drop-'))
  try {
    await waitForDemo(log)
    const link = await post('/v1/auth/magic-link', { email: OWNER })
    const token = (await post('/v1/auth/verify', { token: link.data.token })).data.session_token
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    // 关联 Agents 工坊账号（云替身，不出网）→ 生图自动走积分（GPT Image 2.5 经 OpenRouter）
    await api(token, owner, 'POST', '/v1/cloud/account/link', { email: OWNER })
    let image
    for (let i = 0; i < 60; i += 1) {
      image = await api(token, owner, 'GET', '/v1/models/image')
      if (image.using?.source === 'cloud') break
      await new Promise((r) => setTimeout(r, 500))
    }
    console.log(
      `  生图现在用：${image.using?.label ?? '（没配）'} · edit_mask=${image.using?.edit_mask}`,
    )
    let social = me.assignments.find((a) => a.role_id === 'design.social')?.id
    if (social === undefined) {
      const made = await api(token, owner, 'POST', '/v1/assignments', {
        person_id: me.person.id,
        role_id: 'design.social',
        ranges: [],
      })
      social =
        made?.id ??
        made?.assignment?.id ??
        (await api(token, undefined, 'GET', '/v1/me')).assignments.find(
          (a) => a.role_id === 'design.social',
        )?.id
    }
    const matter = await api(token, social, 'POST', `/v1/positions/${social}/matters`, {
      title: '把这张产品图换个场景：只换桌面',
      role_id: 'design.social',
    })

    // 一张 320×240 的「产品图」（纯色块，够看清涂的那一笔）
    const png = join(dropDir, 'box.png')
    const { encodePng } = await import(join(ROOT, 'packages/model-gateway/dist/index.js'))
    const w = 320
    const h = 240
    // encodePng 收的是原始扫描行：每行开头一个过滤字节（0 = 不过滤）
    const px = new Uint8Array(h * (w * 3 + 1))
    for (let y = 0; y < h; y += 1)
      for (let x = 0; x < w; x += 1) {
        const i = y * (w * 3 + 1) + 1 + x * 3
        const box = x > 110 && x < 210 && y > 60 && y < 170
        px[i] = box ? 225 : y > 170 ? 196 : 238
        px[i + 1] = box ? 29 : y > 170 ? 170 : 236
        px[i + 2] = box ? 46 : y > 170 ? 140 : 232
      }
    writeFileSync(png, encodePng(w, h, px, 'rgb'))

    browser = await chromium.launch({ headless: true })
    const open = async (editMask) => {
      const context = await browser.newContext({ viewport: { width: 1180, height: 820 } })
      await context.addInitScript((t) => {
        try {
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', 'light')
        } catch {
          /* demo 自动登录 */
        }
      }, token)
      // 页面里包一层 fetch：只改传图回包里的 `edit_mask`（请求原样发到 demo）
      if (editMask !== undefined)
        await context.addInitScript((flag) => {
          const orig = window.fetch.bind(window)
          window.fetch = async (input, init) => {
            const res = await orig(input, init)
            const url = typeof input === 'string' ? input : input.url
            if (!url.includes('/v1/brand-assets/upload') || !res.ok) return res
            const body = await res.clone().json()
            body.data.edit_mask = flag
            return new Response(JSON.stringify(body), { status: res.status, headers: res.headers })
          }
        }, editMask)
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/matters/${matter.matter.id}`, { waitUntil: 'networkidle' })
      await page.setInputFiles('[data-testid="matter-say"] input[type="file"]', png)
      await page.waitForSelector('[data-testid="matter-attachments"] img', { timeout: 30_000 })
      await page.fill('[data-testid="matter-say"] textarea', '只把桌面换成大理石，产品别动')
      await page.waitForTimeout(500)
      return { context, page }
    }
    const dock = (page) => page.locator('[data-testid="matter-dock"]')
    const snap = async (locator, name) => {
      await locator.scrollIntoViewIfNeeded()
      await locator.page().waitForTimeout(400)
      await locator.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }

    // ① 经 Agents 工坊积分（OpenRouter 型号）：没有笔刷（demo 真实回包；edit_mask 由型号能力表算）
    {
      const { context, page } = await open(image.using?.source === 'cloud' ? undefined : false)
      if ((await page.locator('[data-testid="matter-attach-mask"]').count()) !== 0)
        throw new Error('经云的型号不该有「圈区域」')
      await snap(dock(page), '1-openrouter-no-mask')
      await context.close()
    }

    // ② 认遮罩的型号（自己的 OpenAI key）：有笔刷 → ③ 涂一笔 → ④ 圈好了
    {
      const { context, page } = await open(true)
      const brush = page.locator('[data-testid="matter-attach-mask"]')
      await brush.waitFor({ timeout: 10_000 })
      await brush.hover()
      await page.waitForTimeout(600)
      await snap(dock(page), '2-own-openai-mask-entry')
      await brush.click()
      const canvas = page.locator('[data-testid="mask-canvas"]')
      await canvas.waitFor({ timeout: 10_000 })
      const box = await canvas.boundingBox()
      if (box === null) throw new Error('画布没出来')
      await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.85)
      await page.mouse.down()
      for (let i = 0; i <= 20; i += 1)
        await page.mouse.move(box.x + box.width * (0.12 + i * 0.038), box.y + box.height * 0.85)
      await page.mouse.up()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(SHOTS, '3-mask-dialog.png') })
      console.log('  📷 3-mask-dialog.png')
      await page.locator('[data-testid="mask-done"]').click()
      await page.waitForSelector('[data-testid="matter-attach-mask"][data-masked="true"]', {
        timeout: 15_000,
      })
      await snap(dock(page), '4-masked')
      // 发出去：话里带上原图与遮罩的素材 id（AI 改图时填进 mask_asset_id）
      await page.press('[data-testid="matter-say"] textarea', 'Enter')
      let said = ''
      for (let i = 0; i < 40 && !said.includes('遮罩'); i += 1) {
        const v = await api(token, social, 'GET', `/v1/matters/${matter.matter.id}`)
        said = v.timeline.filter((x) => x.kind === 'human_message').at(-1)?.text ?? ''
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!/遮罩：dasset_/.test(said)) throw new Error(`话里没带遮罩：${said}`)
      const maskId = /遮罩：(dasset_\w+)/.exec(said)?.[1]
      const assets = await api(token, social, 'GET', '/v1/brand-assets?tag=mask')
      const mask = assets.rows.find((r) => r.id === maskId)
      console.log(
        `  ✓ 话里带上了遮罩 ${maskId}（${mask?.width}×${mask?.height}，用途标 ${mask?.tags}）`,
      )
      await context.close()
    }
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
    rmSync(dropDir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
