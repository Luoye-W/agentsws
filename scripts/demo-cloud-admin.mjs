#!/usr/bin/env node
/**
 * 运营后台的**演示数据 + 截图**（WP115 / docs/65）。
 *
 * 它做四件事：
 *
 * 1. 在一个临时目录里起一个真的云进程（账号库 + 钱包库都是真 sqlite）；
 * 2. 灌**全是假的**种子数据：几十个 `@example.com` 账号、各自的组织、两周的
 *    用量与成本、几笔发放、一个会员 term、两条故意亏本的调用；
 * 3. 直接签一张后台会话（不走发信——这是本机脚本，没有邮箱）；
 * 4. 用 playwright 拍四张图进 `docs/assets/cloud-admin/`。
 *
 * **一条纪律：这里没有一个真实的人**。邮箱全是 `example.com`（RFC 2606 保留域，
 * 永远不会有人真的收到信），组织名是编的，模型名取自成本表。截图会进仓库，
 * 所以它上面的每一个字都必须是假的。
 *
 * 用法：`node scripts/demo-cloud-admin.mjs`（先 `pnpm exec tsc -b` 与
 *      `pnpm --filter @agentsws/cloud-admin exec vite build`）
 *      `--no-shots` 只起服务并印出登录用的 cookie（自己开浏览器看）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'apps/cloud-admin/dist')
const SHOTS = join(ROOT, 'docs/assets/cloud-admin')
/**
 * playwright 的入口。
 *
 * 仓库里没有把它装成顶层依赖（它只被截图脚本用一次），所以直接指到 pnpm 的
 * store 里那一份。路径写死是有意的：这个脚本只在开发机上手工跑，CI 不跑它；
 * 写成"找得到就找"会让"忘了装"变成一次静默跳过。
 */
const PLAYWRIGHT = join(
  ROOT,
  'node_modules/.pnpm/@playwright+test@1.63.0/node_modules/playwright/index.mjs',
)
const shots = !process.argv.includes('--no-shots')

for (const [what, where] of [
  ['apps/cloud', join(ROOT, 'apps/cloud/dist/index.js')],
  ['apps/cloud-admin', join(DIST, 'index.html')],
  ['playwright', PLAYWRIGHT],
]) {
  if (!existsSync(where)) {
    process.stderr.write(
      `demo-cloud-admin: 先构建 ${what}（\`pnpm exec tsc -b\` 与 \`pnpm --filter @agentsws/cloud-admin exec vite build\`）\n`,
    )
    process.exit(70)
  }
}

const cloud = await import(pathToFileURL(join(ROOT, 'apps/cloud/dist/index.js')).href)
const metering = await import(pathToFileURL(join(ROOT, 'packages/metering/dist/index.js')).href)
const sync = await import(pathToFileURL(join(ROOT, 'packages/core/dist/sql/sync-db.js')).href)

/** 演示数据的"现在"。固定一个日子，截图就不会每天都变一遍。 */
const NOW = new Date('2026-09-18T14:20:00.000Z')
let tick = 0
const clock = { now: () => new Date(NOW.getTime() + tick).toISOString() }

const dataDir = mkdtempSync(join(tmpdir(), 'agentsws-admin-demo-'))
mkdirSync(SHOTS, { recursive: true })

/* ── 装配（与 `apps/cloud/src/index.ts` 的 main() 同一套，只是省掉值守与红人库） ── */

let walletHandles
let adminStore
let ledger
let consoleWallet

const consoleRoutes = cloud.adminConsoleRoutes({
  clock,
  accounts: () => server.store,
  admin: () => adminStore,
  wallet: () => consoleWallet,
  ledger: () => ledger,
  baseUrl: 'http://127.0.0.1:4455',
  mail: async () => {},
  bootstrapToken: 'demo-token-not-a-secret-0123456789abcdef0123',
  health: () => server.health,
  warn: () => {},
})

const server = cloud.createCloudServer({
  dataDir,
  clock,
  quiet: true,
  env: { AGENTSWS_CLOUD_BASE_URL: 'http://127.0.0.1:4455' },
  mail: async () => {},
  modules: [consoleRoutes],
})
adminStore = cloud.createAdminStore(server, clock)
const entry = cloud.mountEntry(server, { dataDir, clock, fetch: async () => new Response('{}') })
walletHandles = { wallet: entry.wallet, store: entry.store }
const walletSync = sync.syncDbFromBetterSqlite(entry.store.db)
ledger = metering.sqlUsageLedger(walletSync)
consoleWallet = {
  wallet: entry.wallet,
  port: metering.sqlWalletAdminPort({
    db: walletSync,
    wallet: entry.wallet,
    appendEvent: (e) => entry.store.appendEvent(e),
  }),
}
server.health.modules = { entry: true, mail: true, admin_console: true, kol_public: false }
cloud.mountAdminPages(server, {
  admin: () => adminStore,
  clock,
  baseUrl: 'http://127.0.0.1:4455',
  distDir: DIST,
})

/* ── 种子数据（全是假的） ─────────────────────────────────────────── */

/** 确定性随机：同一个脚本跑两次出同一张图，git diff 才看得出真的改了什么。 */
let seed = 20260918
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const pick = (list) => list[Math.floor(rand() * list.length)]

const BRANDS = [
  '晨光家居',
  '海丘户外',
  '青梧童装',
  '北屿美妆',
  '云舟宠物',
  '砚山文具',
  '麦野食品',
  '沐语香氛',
  '拾光相机',
  '陌野运动',
]
const MODELS = [
  ['deepseek', 'deepseek-flash'],
  ['deepseek', 'deepseek-v4-pro'],
  ['openai', 'gpt-5-mini'],
  ['openai', 'gpt-5'],
  ['zhipu', 'glm-5.3-flash'],
  ['moonshot', 'kimi-k2.6'],
]
const CAPABILITIES = ['ai.chat', 'ai.embeddings', 'data.kol.lookup', 'social.fetch', 'crawl.page']

const orgs = []
for (let i = 0; i < 34; i++) {
  tick += 1000
  const email = `user${String(i + 1).padStart(2, '0')}@example.com`
  const { account, org } = server.store.ensureAccount(email)
  // 注册时间摊到过去九十天里（KPI 那两个 `+N/7d · +N/30d` 才有东西显示）
  const daysAgo = Math.floor(rand() * 90)
  server.store.db
    .prepare('UPDATE cloud_accounts SET created_at = ? WHERE id = ?')
    .run(new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), account.id)
  const name = i < BRANDS.length ? BRANDS[i] : `${pick(BRANDS)}${String(i)}`
  server.store.db.prepare('UPDATE cloud_orgs SET name = ? WHERE id = ?').run(name, org.id)
  // 一部分人验证过邮箱（列表页那个「未验证」标签才有对照）
  if (rand() < 0.8) {
    const issued = server.store.issueLogin(account.id)
    server.store.verifyLogin(issued.token)
  }
  orgs.push({ account, org, name })
}

// 钱：三分之一充过值，一半被发过赠送额度
for (const { org } of orgs) {
  tick += 1000
  if (rand() < 0.35)
    entry.wallet.topup({
      org_id: org.id,
      credits: Math.round((100 + rand() * 900) / 10) * 10,
      kind: 'purchased',
      source_ref: `demo_pay_${org.id}`,
    })
  if (rand() < 0.5)
    entry.wallet.topup({
      org_id: org.id,
      credits: 50,
      kind: 'granted',
      expires_at: new Date(NOW.getTime() + 60 * 86_400_000).toISOString(),
      source_ref: `demo_grant_${org.id}`,
    })
}

// 两周用量：每天几十条，按组织的"活跃度"分布（少数几个吃掉大部分成本）
const weights = orgs.map((_, i) => (i < 4 ? 8 : i < 12 ? 3 : 1))
let requestNo = 0
for (let day = 13; day >= 0; day--) {
  const at = new Date(NOW.getTime() - day * 86_400_000)
  const rows = 30 + Math.floor(rand() * 40)
  for (let n = 0; n < rows; n++) {
    let roll = rand() * weights.reduce((s, w) => s + w, 0)
    let index = 0
    while (roll > weights[index]) roll -= weights[index++]
    const { org } = orgs[index]
    const capability = pick(CAPABILITIES)
    const [provider, model] = MODELS[Math.floor(rand() * MODELS.length)]
    const input_tokens = Math.round(400 + rand() * 4000)
    const output_tokens = Math.round(100 + rand() * 1200)
    const isAi = capability.startsWith('ai.')
    /*
     * 非 token 的那几条能力：供应商按**它真的打了谁**算，价按价目表
     * （`social.fetch` 打 Apify，红人查询与网页抓取走我们自己的库）。
     * 全填 `internal` 会让"按供应商"那张表看起来像只有 AI 有成本。
     */
    const nonAiProvider = capability === 'social.fetch' ? 'apify' : 'internal'
    const cost = isAi
      ? metering.tokenCostMicros(model, { input_tokens, output_tokens })
      : metering.unitCostMicros(`${nonAiProvider}:call`, 1)
    const credits = isAi
      ? // 向用户收的：成本的三倍上下（价目表的倍率就是 3）
        Math.round((cost.micros / 1_000_000) * (2.6 + rand() * 0.9) * 100) / 100
      : (metering.creditsFor(entry.pricing, capability, 1) ?? 0)
    requestNo += 1
    entry.store.appendEvent({
      capability,
      unit: isAi ? '1k_tokens' : 'call',
      quantity: isAi ? (input_tokens + output_tokens) / 1000 : 1,
      credits,
      at: new Date(at.getTime() + Math.floor(rand() * 80_000_000) - 40_000_000).toISOString(),
      org_id: org.id,
      workspace_id: `ws_${org.id.slice(-6)}`,
      request_id: `demo_${String(requestNo)}`,
      provider: isAi ? provider : nonAiProvider,
      ...(isAi ? { model } : {}),
      input_tokens: isAi ? input_tokens : 0,
      output_tokens: isAi ? output_tokens : 0,
      cost_micros: cost.micros,
      cost_currency: cost.currency,
      charge_status: 'charged',
    })
  }
}

// 两条**故意亏本**的行：亏本告警那张卡要有东西显示（0 行时它整张不渲染）
for (const loss of [
  { model: 'gpt-6-astra', input_tokens: 9_000, output_tokens: 2_500, credits: 0.4 },
  { model: 'kimi-k3', input_tokens: 7_000, output_tokens: 1_800, credits: 0.3 },
]) {
  requestNo += 1
  const cost = metering.tokenCostMicros(loss.model, loss)
  entry.store.appendEvent({
    capability: 'ai.chat',
    unit: '1k_tokens',
    quantity: (loss.input_tokens + loss.output_tokens) / 1000,
    credits: loss.credits,
    at: new Date(NOW.getTime() - 3_600_000).toISOString(),
    org_id: orgs[1].org.id,
    workspace_id: `ws_${orgs[1].org.id.slice(-6)}`,
    request_id: `demo_loss_${String(requestNo)}`,
    provider: metering.providerOfModel(loss.model),
    model: loss.model,
    input_tokens: loss.input_tokens,
    output_tokens: loss.output_tokens,
    cost_micros: cost.micros,
    cost_currency: cost.currency,
    charge_status: 'charged',
  })
}

// 一个会员 term、一个被封的人、一个被停用的组织
const plan = metering.planById('beta-tester')
const term = adminStore.createTerm({
  org_id: orgs[0].org.id,
  plan_id: plan.id,
  anchor_at: new Date(NOW.getTime() - 40 * 86_400_000).toISOString(),
  starts_at: new Date(NOW.getTime() - 40 * 86_400_000).toISOString(),
  ends_at: new Date(NOW.getTime() + 140 * 86_400_000).toISOString(),
  status: 'active',
  created_by: 'system',
  created_at: clock.now(),
  note: '内测朋友',
})
adminStore.putCycles(
  metering
    .planCycles({
      term_id: term.id,
      plan,
      anchor_at: term.anchor_at,
      ends_at: term.ends_at,
    })
    // `PlannedCycle` 里没有 `term_id`（它是算出来的那一半），落库时补上
    .map((c) => ({ ...c, term_id: term.id, org_id: orgs[0].org.id })),
)
cloud.runDueGrants(adminStore, entry.wallet, clock)
adminStore.ban({
  account_id: orgs[5].account.id,
  reason: '脚本刷公共红人库接口',
  banned_by: 'system',
})
adminStore.suspendOrg(orgs[7].org.id, '退款争议处理中')

// 一把工作区关联令牌（组织抽屉里那一栏要有东西）
server.store.createLink({
  workspace_id: `ws_${orgs[0].org.id.slice(-6)}`,
  cloud_org_id: orgs[0].org.id,
  created_by: orgs[0].account.id,
  label: '晨光家居 · MacBook',
})

/* ── 后台账号与一张会话 ───────────────────────────────────────────── */

const { account: boss } = server.store.ensureAccount('ops@example.com')
adminStore.setRole(boss.id, 'admin')
/*
 * **走真的登录那条路**（一次性 token → `/admin/callback` → 种 cookie），
 * 不是直接往浏览器里塞一张会话。理由：那条路上有 `__Host-` 前缀、`Secure`、
 * 重定向三件事，直接塞 cookie 会把它们全跳过，于是截图脚本能过而真人登不进去。
 */
const login = server.store.issueLogin(boss.id)

const { port } = await server.listen(4455)
const base = `http://127.0.0.1:${String(port)}`
process.stdout.write(
  `demo-cloud-admin: ${String(orgs.length)} 个假账号 / ${String(requestNo)} 条用量 → ${base}/admin/\n`,
)

if (!shots) {
  process.stdout.write(
    `登录一次：${base}/admin/callback?token=${login.token}\n` +
      '（Ctrl-C 停；数据在临时目录里，停了就没了）\n',
  )
} else {
  /*
   * 截图脚本单独写成一个文件再用 node 跑：playwright 只在开发机上有，
   * 把它 import 进这个脚本会让"没装 playwright"变成整个脚本起不来，
   * 而 `--no-shots` 那一半本来是不需要它的。
   */
  const script = join(dataDir, 'shots.mjs')
  const { writeFileSync } = await import('node:fs')
  const lines = [
    'import { chromium } from ' + JSON.stringify(pathToFileURL(PLAYWRIGHT).href),
    'const base = ' + JSON.stringify(base),
    'const out = ' + JSON.stringify(SHOTS),
    'const login = ' + JSON.stringify(`${base}/admin/callback?token=${login.token}`),
    // --no-proxy-server：这台机器上可能配了 HTTP(S)_PROXY，Chromium 会拿它去连
    // 127.0.0.1 然后一直等到超时。截图打的是本机回环，不该经过任何代理。
    "const browser = await chromium.launch({ args: ['--no-proxy-server'] })",
    'const context = await browser.newContext({',
    '  viewport: { width: 1440, height: 960 },',
    '  deviceScaleFactor: 2,',
    "  locale: 'zh-CN',",
    '})',
    'const page = await context.newPage()',
    // 走真的登录那条路（一次性链接 → 302 → 两张 cookie），不是往浏览器里塞 cookie：
    // 直接塞会把 __Host- 前缀、Secure、重定向三件事全跳过，于是脚本过而真人登不进去
    "await page.goto(login, { waitUntil: 'domcontentloaded' })",
    'const shot = async (path, file, after) => {',
    // networkidle 在这一页上永远等不到（字体与 SPA 的轮询会一直有连接），
    // 所以等的是"那一页自己的标题出来了"
    "  await page.goto(base + path, { waitUntil: 'domcontentloaded' })",
    "  await page.waitForSelector('h1', { timeout: 15000 })",
    '  if (after) await after()',
    '  await page.waitForTimeout(1200)',
    "  await page.screenshot({ path: out + '/' + file })",
    "  process.stdout.write('  ' + file + '\\n')",
    '}',
    "await shot('/admin/', 'overview.png')",
    "await shot('/admin/users', 'users-drawer.png', async () => {",
    // 点第二行：第一行是刚登录的那个运营账号自己，抽屉里全是 0，不代表典型
    '  await page.locator(\'[data-testid="row"]\').nth(1).click()',
    '  await page.waitForSelector(\'[data-testid="drawer"]\')',
    '})',
    "await shot('/admin/usage', 'usage.png')",
    "await shot('/admin/credits', 'credits.png')",
    'await browser.close()',
  ]
  writeFileSync(script, `${lines.join('\n')}\n`)
  /*
   * **异步起子进程，不用 `execFileSync`**。
   *
   * 云进程就跑在这个 node 里；`execFileSync` 会把事件循环整个堵住，于是浏览器
   * 那一头连得上端口却等不到任何响应，最后超时——看起来像"服务没起来"，
   * 实际上是"服务起来了但没人去 accept"。这一条踩过一次。
   */
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: ROOT, stdio: 'inherit' })
    child.on('exit', (status) => resolve(status ?? 1))
    child.on('error', () => resolve(1))
  })
  if (code !== 0) {
    process.stderr.write('demo-cloud-admin: 截图失败\n')
    process.exitCode = 1
  }
  await server.close()
  entry.store.close?.()
  rmSync(dataDir, { recursive: true, force: true })
  process.stdout.write(`demo-cloud-admin: 四张图 → ${SHOTS}\n`)
}
