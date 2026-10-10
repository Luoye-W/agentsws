#!/usr/bin/env node
/**
 * WP290（决策 332，docs/96 §6）：**装包前真机冒烟**——每次给 Windows 装包之前，先在本机用**真的 dsh 运行时**
 * 把每个岗位走一遍。挂了不装。
 *
 * 为什么要它：10-09 真机上店铺工具的参数表 dsh 不认，运行一启动就挂；单测与三包模拟全绿（模拟没摆这些工具、
 * 没走真 dsh 的工具编译），到了 Windows 才暴露。
 *
 * 做什么（全在本机，不联网、不花钱、不碰 4317）：
 *   1. 起一个本机假模型（OpenAI 兼容，按剧本回固定的工具调用 / 文字，见 `preinstall-smoke-model.mjs`）；
 *   2. 用**当前构建**（或 `--app` 指定的已打好的产物）的服务端，在临时数据目录里起服务，听随机端口；
 *      每一次有模型的运行都走 dsh（`runtime.dshAllRuns`），dsh 装配形态与安装包一样（`auto` = 子进程）；
 *      店铺授权、生图这几样「接上了才摆工具」的，用服务端自带的本机替身接上，让工具都摆进运行；
 *   3. 每个岗位模板建一个岗位（本人持有它的全部职责）→ 每条职责各跑一次（工具全过 dsh 的编译）
 *      → 岗位入口问一句（当场答）→ 交办一件（建事项、出一张卡）→ 点掉卡 → 事项状态对
 *      → 故意让模型报错一次，界面要显示「没跑成」而不是「跑完了」；
 *   4. 打一张表（岗位 × 步骤），失败带原始错误；任一失败退出码 1。跑完删临时目录。
 *
 * 「问一句当场答」「没跑成」两格要 WP287 的服务端：老服务端（开事项的回包里没有 `mode`）上记「等 WP287」，不算失败。
 *
 * 用法：
 *   node scripts/preinstall-smoke.mjs                       # 用当前构建（先 `npx tsc -b`）
 *   node scripts/preinstall-smoke.mjs --app <目录>           # 用已打好的产物（`<resources>`、`win-unpacked`、`.app` 都认）
 *   node scripts/preinstall-smoke.mjs --positions web-ops,site --json out.json --keep
 *
 * 退出码：0 全过（含「等 WP287」）；1 有一格没过；2 起不来（服务端 / 假模型 / 本机替身没装上）。
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  MARK_CARD,
  MARK_FAIL,
  SMOKE_ANSWER,
  SMOKE_MODEL,
  startFakeModel,
} from './preinstall-smoke-model.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 表头（顺序 = 每个岗位走的顺序）。 */
export const STEPS = [
  ['position', '建岗位'],
  ['tools', '工具过 dsh'],
  ['ask', '问一句'],
  ['delegate', '交办·出卡'],
  ['decide', '点掉卡'],
  ['state', '事项状态'],
  ['failure', '没跑成'],
]

/** 店铺工具登记在哪几条职责上（`@agentsws/stand-ins` 的 `SHOP_TOOLS_BY_ROLE`）；授权时一起要权限。 */
const SHOP_ROLES = ['dtc.store', 'site.shopify-build', 'site.shopify-theme']
const SMOKE_STORE = 'smoke-test.myshopify.com'

// ── 参数与产物 ─────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => {
      i += 1
      if (argv[i] === undefined) throw new Error(`${a} 后面要跟一个值`)
      return argv[i]
    }
    if (a === '--app') out.app = next()
    else if (a === '--positions')
      out.positions = next()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    else if (a === '--json') out.json = next()
    else if (a === '--keep') out.keep = true
    else if (a === '--dsh-mode') out.dshMode = next()
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`不认识的参数：${a}`)
  }
  return out
}

/**
 * 服务端入口在哪。不给 `app` = 仓库里的当前构建；给了就按安装包的布局找：
 * `<resources>/app/node_modules/@agentsws/server/dist`（`<resources>` 可以是 win-unpacked/resources、
 * mac 的 `.app/Contents/Resources`，也可以直接给 `win-unpacked` 或 `.app`）。
 * 回 `{ entry, resources?, node?, profileDir? }`；找不到回 `undefined`。
 */
export function resolveServer({ app, exists = existsSync, platform = process.platform } = {}) {
  if (app === undefined) {
    const entry = join(REPO, 'apps', 'server', 'dist', 'index.js')
    return exists(entry) ? { entry } : undefined
  }
  const base = resolve(app)
  const roots = [base, join(base, 'resources'), join(base, 'Contents', 'Resources')]
  for (const root of roots) {
    const entry = join(root, 'app', 'node_modules', '@agentsws', 'server', 'dist', 'index.js')
    if (!exists(entry)) continue
    const node = join(root, 'node', platform === 'win32' ? 'node.exe' : join('bin', 'node'))
    const flat = join(root, 'node', platform === 'win32' ? 'node.exe' : 'node')
    const profileDir = join(root, 'profiles', 'agentsws')
    return {
      entry,
      resources: root,
      ...(exists(node) ? { node } : exists(flat) ? { node: flat } : {}),
      ...(exists(profileDir) ? { profileDir } : {}),
    }
  }
  // 也认直接给一个 app 目录（`<resources>/app`）或服务端包目录
  for (const entry of [
    join(base, 'node_modules', '@agentsws', 'server', 'dist', 'index.js'),
    join(base, 'dist', 'index.js'),
  ]) {
    if (exists(entry)) return { entry }
  }
  return undefined
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

const pass = (text) => ({ status: 'pass', text })
const fail = (text, error) => ({ status: 'fail', text, ...(error === undefined ? {} : { error }) })
const pending = (text, observed) => ({
  status: 'pending',
  text,
  ...(observed === undefined ? {} : { observed }),
})
const skipped = (text) => ({ status: 'skip', text })
const errText = (e) => (e instanceof Error ? e.message : String(e))
const clipLine = (s, n = 300) => {
  const line = String(s).replace(/\s+/g, ' ').trim()
  return line.length <= n ? line : `${line.slice(0, n - 1)}…`
}

/** 只认本次运行的事件（服务端事件日志，进程内直接读）。 */
function runEventsOf(server, run_id) {
  return server.kernel.eventLog
    .readSync({ workspace_id: server.bootstrap.workspace.id })
    .filter((e) => e.correlation?.run_id === run_id)
}

/** 这次运行的结论：runtime 名字、跑完 / 没跑成（带原始错误）。 */
export function runVerdict(events) {
  const started = events.find((e) => e.type === 'run.started')
  const failed = events.find((e) => e.type === 'run.failed')
  const completed = events.find((e) => e.type === 'run.completed')
  const cancelled = events.find((e) => e.type === 'run.cancelled')
  const runtime = started?.payload?.runtime
  if (started === undefined) return { ok: false, runtime, error: '没起运行（没有 run.started）' }
  if (failed !== undefined) {
    const err = failed.payload?.error ?? {}
    return {
      ok: false,
      runtime,
      error: `run.failed ${err.code ?? ''}: ${err.message ?? ''}`.trim(),
    }
  }
  if (cancelled !== undefined)
    return { ok: false, runtime, error: `run.cancelled: ${cancelled.payload?.reason ?? ''}` }
  if (completed === undefined)
    return { ok: false, runtime, error: '运行没收尾（没有 run.completed）' }
  return { ok: true, runtime }
}

// ── 起服务 ─────────────────────────────────────────────────────────────────

/**
 * 在临时目录里起服务端（随机端口、只听 127.0.0.1）+ 假模型，并把「接上了才摆工具」的几样用本机替身接上。
 * 回 `{ server, url, model, call, shop, tmp, close }`。
 */
export async function bootSmoke({ serverModule, profileDir, dshMode, log = () => {} }) {
  const S = serverModule
  const tmp = mkdtempSync(join(tmpdir(), 'agentsws-preinstall-smoke-'))
  const dataDir = join(tmp, 'data')
  const dshHome = join(tmp, 'dsh')
  mkdirSync(dataDir)
  mkdirSync(dshHome)
  // dsh 子进程继承这个进程的环境：它的家目录也落在临时目录里；模型 key 一律不往下传（只删名字，不读值）
  process.env.DSH_HOME = dshHome
  process.env.AGENTSWS_DSH_HOME = dshHome
  for (const name of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])
    delete process.env[name]

  const model = await startFakeModel()
  let shopInstalled = false
  const shop = S.demoShop()
  const env = {
    // 这一次临时数据目录的本机加密库钥匙：现生成、只在这个进程里、跑完随目录删掉
    AGENTSWS_SECRETS_KEY: randomBytes(32).toString('hex'),
    AGENTSWS_OWNER_EMAIL: 'smoke@example.test',
    // 云与连接器都指到一个没人听的本机端口：冒烟一个字节都不出网
    AGENTSWS_CLOUD_BASE_URL: 'http://127.0.0.1:9',
    AGENTSWS_CONNECT_URL: 'http://127.0.0.1:9',
    AGENTSWS_CONTENT_UPDATES: 'off',
    AGENTSWS_DSH_HOME: dshHome,
    DSH_HOME: dshHome,
    AGENTSWS_APP_DATA_DIR: tmp,
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
  }
  let officialPlugins
  if (profileDir !== undefined) {
    const mod = await import(pathToFileURL(join(dirname(S.__entry), 'official-plugins.js')).href)
    officialPlugins = mod.officialPluginPathsIn(profileDir)
  }
  const server = await S.createServer({
    dbDir: dataDir,
    quiet: true,
    env,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    // 局域网发现一律不开（不往外广播）
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    // 店铺授权：服务端自带的进程内假 Shopify CLI + 一家假店（不起子进程、不联网、不碰真店）
    platformCliExec: async (bin) => {
      if (bin === 'node') return { ok: true, stdout: 'v22.12.0' }
      return shopInstalled
        ? { ok: true, stdout: 'Current Shopify CLI version: 4.8.5' }
        : { ok: false, stdout: '', missing: true }
    },
    shopAdmin: {
      run: S.shopAdminRunStandIn(shop),
      spawn: S.shopAuthSpawnStandIn(shop, { delayMs: 20 }),
    },
    runtime: { dshAllRuns: true, ...(dshMode === undefined ? {} : { dshMode }) },
    ...(officialPlugins === undefined ? {} : { officialPlugins }),
  })
  const { url } = await server.listen(0)
  const token = server.bootstrap.internalToken
  /** 打本机服务（真 HTTP；令牌只在这个进程里，不打印）。回 `{ status, data?, code?, message? }`。 */
  const call = async (method, path, body, assignment = server.bootstrap.ownerAssignment.id) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Assignment': assignment,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(180_000),
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, ...json }
  }
  const close = async () => {
    await server.close().catch(() => undefined)
    await model.close().catch(() => undefined)
  }
  log(`服务：${url}（临时目录 ${tmp}）  假模型：${model.baseUrl}`)
  return {
    server,
    url,
    model,
    call,
    tmp,
    close,
    installShopCli: () => {
      shopInstalled = true
    },
  }
}

/** 一条 API 调用必须成功，否则抛出带原始回包的错误。 */
function must(res, what) {
  if (res.status >= 200 && res.status < 300 && res.data !== undefined) return res.data
  throw new Error(`${what}：HTTP ${res.status} ${res.code ?? ''} ${res.message ?? ''}`.trim())
}

/**
 * 环境：接模型（本机假模型）、接生图（同一个假模型）、店铺授权（进程内假 CLI）。
 * 每一样回 `{ name, ok, error? }`；模型没接上 = 冒烟起不来。
 */
export async function prepareWorld(ctx) {
  const { call, model, server } = ctx
  const out = []
  const step = async (name, fn) => {
    try {
      await fn()
      out.push({ name, ok: true })
    } catch (e) {
      out.push({ name, ok: false, error: errText(e) })
    }
  }
  await step('接模型（本机假模型）', async () => {
    must(
      await call('PUT', '/v1/models/providers/smoke', {
        kind: 'openai_compatible',
        label: '冒烟假模型',
        base_url: model.baseUrl,
        model: SMOKE_MODEL,
        // 假模型不看 key；这一串只为过表单校验
        api_key: 'smoke-not-a-real-key',
      }),
      '存模型',
    )
  })
  await step('接生图（同一个假模型）', async () => {
    must(
      await call('PUT', '/v1/models/image', { provider_id: 'smoke', model: 'smoke-image' }),
      '存生图',
    )
  })
  await step('店铺授权（进程内假 Shopify CLI）', async () => {
    const ws = server.bootstrap.workspace.id
    must(
      await call('PUT', '/v1/workspace/profile', {
        legal_name: '冒烟小店',
        storefront_platform: 'shopify',
      }),
      '品牌档案',
    )
    // 授权要一条店铺管理的分配在手上（岗位那一格会再按岗位分一次，这条单独建、只为授权）
    const store = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: ws,
      role_id: 'dtc.store',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'brand', id: ws }],
    })
    ctx.installShopCli()
    must(await call('POST', '/v1/platform-kit/cli/check', {}), 'CLI 检测')
    await call('GET', '/v1/site/theme?fresh=1', undefined, store.id)
    must(
      await call(
        'PUT',
        '/v1/shop-admin/store',
        { store: SMOKE_STORE, roles: SHOP_ROLES },
        store.id,
      ),
      '选店',
    )
    must(
      await call(
        'POST',
        '/v1/shop-admin/run',
        { action: 'authorize', roles: SHOP_ROLES },
        store.id,
      ),
      '授权',
    )
    let state
    for (let i = 0; i < 200; i += 1) {
      state = must(
        await call('GET', `/v1/shop-admin?roles=${SHOP_ROLES.join(',')}`, undefined, store.id),
        '授权状态',
      ).state
      if (state === 'authorized') break
      await new Promise((r) => setTimeout(r, 25))
    }
    if (state !== 'authorized') throw new Error(`店铺授权没成：停在 ${state}`)
    // 这条只为授权建的分配收回（岗位那一格按岗位分）
    server.roles.assignments.revoke(store.id)
  })
  return out
}

// ── 每个岗位走一遍 ─────────────────────────────────────────────────────────

/** 开一件事（岗位入口）。`mode` 老服务端会被丢掉；回包里有没有 `mode` 就是「WP287 合没合」。 */
async function openAt(ctx, position_id, body, assignment) {
  const res = await ctx.call('POST', `/v1/positions/${position_id}/matters`, body, assignment)
  return must(res, '岗位入口开事项')
}

/**
 * 老服务端拿不准时出一张「该走哪条职责」的选择卡、或者一条都不像就「先问一句」，不起运行——照人会做的那样
 * 挑候选里的第一条（没有候选就挑岗位的第一条职责）接着做（`reroute`）。WP287 起岗位入口永不出选择卡，
 * 新服务端（回包带 `mode`）还没起运行就是错。
 */
async function ensureRun(ctx, opened, assignment, firstDuty) {
  if (opened.run_id !== undefined) return { run_id: opened.run_id, picked: opened.picked }
  if (opened.mode !== undefined)
    throw new Error(`岗位入口没起运行（WP287 起不该出选择卡）：${clipLine(opened.reason ?? '')}`)
  const role_id = opened.candidates?.[0]?.role_id ?? firstDuty
  if (role_id === undefined) throw new Error(`没起运行：${clipLine(opened.reason ?? '')}`)
  const rerouted = must(
    await ctx.call(
      'POST',
      `/v1/matters/${opened.matter.id}/reroute`,
      { role_id, run: true },
      assignment,
    ),
    '换职责接着做',
  )
  if (rerouted.run_id === undefined) throw new Error('换了职责也没起运行')
  return {
    run_id: rerouted.run_id,
    picked: { role_id, assignment_id: rerouted.assignment_id },
    chose: true,
  }
}

/** 这次运行里假模型看到的工具（按请求序号的时间窗归）。 */
function toolsSeen(model, fromSeq) {
  const seen = new Set()
  for (const r of model.requests) if (r.seq > fromSeq) for (const t of r.tools) seen.add(t)
  return [...seen].sort()
}
const lastSeq = (model) => model.requests.at(-1)?.seq ?? 0

/** 岗位视图里这件事那一项。 */
async function workItem(ctx, position_id, matter_id, assignment) {
  const view = must(
    await ctx.call('GET', `/v1/positions/${position_id}/work`, undefined, assignment),
    '岗位视图',
  )
  return view.items.find((i) => i.matter_id === matter_id || i.ref_id === matter_id)
}

/** 时间线上这次运行的那一行摘要（「跑完了」/「这次没跑成」）。 */
async function digestOf(ctx, matter_id, run_id, assignment) {
  const tl = must(
    await ctx.call('GET', `/v1/matters/${matter_id}/timeline`, undefined, assignment),
    '事项时间线',
  )
  const events = Array.isArray(tl) ? tl : (tl.events ?? tl.items ?? [])
  const mine = events.filter((e) => e.run_id === run_id)
  return {
    outcome: mine.find((e) => e.run_digest !== undefined)?.run_digest?.outcome,
    texts: mine.filter((e) => e.kind === 'status').map((e) => e.text),
  }
}

/**
 * 一个岗位：建岗位 → 每条职责过 dsh → 问一句 → 交办出卡 → 点掉 → 事项状态 → 没跑成。
 * 回 `{ id, name, duties, cells: { [step]: { status, text, error? } } }`。
 */
export async function smokePosition(ctx, position, log = () => {}, { toolsOnly = false } = {}) {
  const { server, call, model } = ctx
  const person = server.bootstrap.person.id
  const ws = server.bootstrap.workspace.id
  const duties = position.roles.filter((r) => r.role_id !== 'common.member' && r.loaded !== false)
  const row = {
    id: position.id,
    name: position.name,
    duties: duties.map((d) => d.role_id),
    /** 每条职责那一次运行里模型看到的工具（JSON 里留着，排查时看哪个没摆进去） */
    tools: {},
    cells: {},
  }
  const set = (k, v) => {
    row.cells[k] = v
  }
  const rest = (why) => {
    for (const [k] of STEPS) if (row.cells[k] === undefined) set(k, skipped(why))
  }

  // ① 建岗位：本人持有这个岗位的全部职责（含默认不勾的）
  const asgByRole = new Map()
  try {
    const held = server.roles.assignments
      .listByPerson(person, {})
      .filter((a) => a.workspace_id === ws && a.revoked_at === undefined)
    for (const a of held) asgByRole.set(a.role_id, a.id)
    const missing = duties.filter((d) => !asgByRole.has(d.role_id))
    if (missing.length > 0) {
      const created = must(
        await call('POST', '/v1/assignments', {
          person_id: person,
          position_id: position.id,
          include: duties.filter((d) => !d.default).map((d) => d.role_id),
          ranges: [{ kind: 'brand', id: ws }],
        }),
        '按岗位分配',
      )
      for (const a of created) asgByRole.set(a.role_id, a.assignment_id)
    }
    const lacking = duties.filter((d) => !asgByRole.has(d.role_id)).map((d) => d.role_id)
    if (lacking.length > 0) throw new Error(`分配之后仍缺：${lacking.join('、')}`)
    set('position', pass(`${duties.length} 条职责`))
  } catch (e) {
    set('position', fail('分不上', errText(e)))
    rest('岗位没建成')
    return row
  }
  const anyAsg = asgByRole.get(duties[0].role_id)

  // ② 每条职责各跑一次：全部工具摆进运行、过 dsh 自己的编译
  const toolErrors = []
  let maxTools = 0
  for (const duty of duties) {
    const asg = asgByRole.get(duty.role_id)
    log(`  · ${position.name} / ${duty.name}`)
    try {
      const from = lastSeq(model)
      const opened = await openAt(
        ctx,
        position.id,
        { title: `冒烟：${duty.name}这条职责，回一句就行`, role_id: duty.role_id, mode: 'task' },
        asg,
      )
      const { run_id } = await ensureRun(ctx, opened, asg, duty.role_id)
      const v = runVerdict(runEventsOf(server, run_id))
      const tools = toolsSeen(model, from)
      maxTools = Math.max(maxTools, tools.length)
      row.tools[duty.role_id] = tools
      if (!v.ok) toolErrors.push(`${duty.role_id}：${v.error}`)
      else if (!String(v.runtime ?? '').startsWith('dsh'))
        toolErrors.push(`${duty.role_id}：没走 dsh（runtime=${v.runtime}）`)
      else if (tools.length === 0) toolErrors.push(`${duty.role_id}：模型一个工具都没看到`)
    } catch (e) {
      toolErrors.push(`${duty.role_id}：${errText(e)}`)
    }
  }
  set(
    'tools',
    toolErrors.length === 0
      ? pass(`${duties.length}/${duties.length} 条 · 最多 ${maxTools} 个工具`)
      : fail(`${duties.length - toolErrors.length}/${duties.length} 条`, toolErrors.join('\n')),
  )

  // 「负责人」是身份、不是干活的岗位（docs/54 §6.5：左栏与首页都没有它的岗位页）——只验它的工具
  if (toolsOnly) {
    rest('身份那一行，没有岗位页')
    return row
  }

  // ③ 岗位入口问一句（WP287：当场答，不建进行中的事）
  // WP291：不点名、让服务端三分——判断那一次也过这个品牌的模型网关（假模型回的不是那行 JSON → 按规则判成当场问答），
  // 当场问答那次运行照样走 dsh。WP287 的服务端回 `ask`、WP291 起回 `quick`，都算当场答
  let wp287 = false
  try {
    const opened = await openAt(ctx, position.id, { title: '冒烟：现在店里有哪些产品？' }, anyAsg)
    wp287 = opened.mode !== undefined
    if (!wp287) set('ask', pending('等 WP287', '老服务端：问一句也开成了一件事'))
    else if (opened.mode !== 'ask' && opened.mode !== 'quick')
      set('ask', fail(`没当场答（mode=${opened.mode}）`))
    else if (opened.answer?.outcome !== 'answered')
      set(
        'ask',
        fail(`回答是 ${opened.answer?.outcome}`, opened.answer?.failure ?? opened.answer?.text),
      )
    else if (!String(opened.answer.text).includes(SMOKE_ANSWER.slice(0, 6)))
      set('ask', fail('回答不是模型说的那句', clipLine(opened.answer.text)))
    else set('ask', pass('当场答了'))
  } catch (e) {
    set('ask', fail('问不出去', errText(e)))
  }

  // ④ 交办一件：建事项 → 运行起草一封回信 → 出一张卡
  let matter_id
  let card
  let deciderAsg = anyAsg
  try {
    const opened = await openAt(
      ctx,
      position.id,
      { title: `${MARK_CARD} 冒烟：起草一封给客户的回信，先别发，给我看稿`, mode: 'task' },
      anyAsg,
    )
    wp287 = wp287 || opened.mode !== undefined
    matter_id = opened.matter.id
    const run = await ensureRun(ctx, opened, anyAsg, duties[0].role_id)
    deciderAsg = run.picked?.assignment_id ?? anyAsg
    const v = runVerdict(runEventsOf(server, run.run_id))
    if (!v.ok) throw new Error(v.error)
    const queue = must(await call('GET', '/v1/approvals', undefined, deciderAsg), '要你处理')
    const items = Array.isArray(queue) ? queue : (queue.items ?? [])
    const found = items.find(
      (i) => i.subject?.matter_id === matter_id && ['pending', 'in_review'].includes(i.state),
    )
    if (found === undefined) throw new Error('跑完了，但没出卡（「要你处理」里没有这件事的卡）')
    const before = await workItem(ctx, position.id, matter_id, deciderAsg)
    if (before === undefined || before.cards < 1)
      throw new Error(
        `出了卡，岗位视图却没挂上（${JSON.stringify(before && { group: before.group, cards: before.cards })}）`,
      )
    card = found
    set(
      'delegate',
      pass(`${run.chose === true ? '（老服务端没挑职责，按第一条）' : ''}出卡：${card.kind}`),
    )
  } catch (e) {
    set('delegate', fail('没出卡', errText(e)))
  }

  // ⑤ 点掉卡（主按钮：批）
  if (card === undefined) set('decide', skipped('没有卡'))
  else {
    try {
      const res = await call(
        'POST',
        `/v1/approvals/${card.id}/decide`,
        { action: 'approve' },
        deciderAsg,
      )
      const item = must(res, '点卡')
      if (['pending', 'in_review'].includes(item.state)) throw new Error(`点了还是 ${item.state}`)
      set('decide', pass(`批了 → ${item.state}`))
    } catch (e) {
      // 10-09 第 6 条（① 里发给本人的卡本人点不动）由 WP287 修；老服务端上记「等 WP287」并带上原始错误
      if (!wp287 && /approval\.approve/.test(errText(e)))
        set('decide', pending('等 WP287', errText(e)))
      else set('decide', fail('点不掉', errText(e)))
    }
  }

  // ⑥ 事项状态：卡点掉之后不再挂「等你定」，落进「已完成」
  if (matter_id === undefined || row.cells.decide.status !== 'pass')
    set('state', skipped('前一步没过'))
  else {
    try {
      const item = await workItem(ctx, position.id, matter_id, deciderAsg)
      if (item === undefined) throw new Error('岗位视图里找不到这件事')
      if (item.cards !== 0 || item.group !== 'done')
        throw new Error(`group=${item.group} cards=${item.cards} status=${item.status}`)
      set('state', pass('已完成、0 张卡'))
    } catch (e) {
      set('state', fail('状态不对', errText(e)))
    }
  }

  // ⑦ 故意让模型报错：界面要说「没跑成」，不能说「跑完了」
  try {
    const opened = await openAt(
      ctx,
      position.id,
      { title: `${MARK_FAIL} 冒烟：这一句会让假模型报错`, mode: 'task' },
      anyAsg,
    )
    wp287 = wp287 || opened.mode !== undefined
    const run = await ensureRun(ctx, opened, anyAsg, duties[0].role_id)
    const asg = run.picked?.assignment_id ?? anyAsg
    const digest = await digestOf(ctx, opened.matter.id, run.run_id, asg)
    const item = await workItem(ctx, position.id, opened.matter.id, asg)
    const shown = `摘要=${digest.outcome ?? '无'}，分组=${item?.group ?? '无'}`
    const ok = digest.outcome === 'failed' && item?.group === 'stuck'
    if (ok) set('failure', pass('显示没跑成'))
    else if (!wp287) set('failure', pending('等 WP287', `现在：${shown}`))
    else set('failure', fail('失败被显示成别的', `${shown}；${digest.texts.join(' / ')}`))
  } catch (e) {
    set('failure', fail('这一步出错', errText(e)))
  }
  return row
}

// ── 整轮 ───────────────────────────────────────────────────────────────────

/** 载入服务端模块（记下入口，装了 profile 时要从同一个 dist 取 `official-plugins.js`）。 */
export async function loadServer(entry) {
  const mod = await import(pathToFileURL(entry).href)
  return { ...mod, __entry: entry }
}

/**
 * 跑一整轮。`serverModule` 由调用方载入（测试可以先改坏一个工具参数表再传进来）。
 * 回 `{ ok, world, rows, ms }`；`ok` = 环境全接上、没有一格是 fail。
 */
export async function runSmoke({
  serverModule,
  profileDir,
  dshMode,
  positions,
  keep = false,
  log = () => {},
}) {
  const t0 = Date.now()
  const ctx = await bootSmoke({ serverModule, profileDir, dshMode, log })
  try {
    const world = await prepareWorld(ctx)
    for (const w of world) log(`${w.ok ? '✓' : '✗'} ${w.name}${w.ok ? '' : `：${w.error}`}`)
    if (!world[0].ok) return { ok: false, world, rows: [], ms: Date.now() - t0 }
    const all = must(await ctx.call('GET', '/v1/org/positions'), '岗位清单')
    // 「普通成员」只有底座职责，不是干活的岗位；「负责人」是身份那一行，也要走（它的工具一样进运行）
    const picked = all
      .filter((p) => p.roles.some((r) => r.role_id !== 'common.member' && r.loaded !== false))
      .filter((p) => positions === undefined || positions.includes(p.id))
    const rows = []
    for (const p of picked) {
      log(`▸ ${p.name}（${p.id}）`)
      rows.push(await smokePosition(ctx, p, log, { toolsOnly: p.id === 'owner' }))
    }
    const ok =
      world.every((w) => w.ok) &&
      rows.length > 0 &&
      rows.every((r) => Object.values(r.cells).every((c) => c.status !== 'fail'))
    return { ok, world, rows, ms: Date.now() - t0 }
  } finally {
    await ctx.close()
    if (!keep) {
      // Windows 上服务刚停、SQLite 句柄可能还没放（EBUSY）：多试几次；还删不掉就留着，不让收尾把结果判成红（10-10 发版演练）
      try {
        rmSync(ctx.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
      } catch (e) {
        log(`临时目录没删掉（${e instanceof Error ? e.message : String(e)}），留在：${ctx.tmp}`)
      }
    } else log(`临时目录留着：${ctx.tmp}`)
  }
}

const MARK = { pass: '✓', fail: '✗', pending: '…', skip: '–' }

/** 结果表（Markdown，终端里也看得懂）+ 失败的原始错误。 */
export function renderTable(result) {
  const lines = []
  lines.push(`| 岗位 | ${STEPS.map(([, t]) => t).join(' | ')} |`)
  lines.push(`|---|${STEPS.map(() => '---').join('|')}|`)
  for (const r of result.rows) {
    const cells = STEPS.map(([k]) => {
      const c = r.cells[k]
      return c === undefined ? '' : `${MARK[c.status]} ${c.text}`
    })
    lines.push(`| ${r.name}（${r.id}） | ${cells.join(' | ')} |`)
  }
  const problems = []
  for (const w of result.world ?? []) if (!w.ok) problems.push(`- 环境 · ${w.name}：${w.error}`)
  for (const r of result.rows)
    for (const [k, t] of STEPS) {
      const c = r.cells[k]
      if (c?.status === 'fail')
        problems.push(
          `- ${r.name} · ${t}：${c.text}\n    ${String(c.error ?? '')
            .split('\n')
            .join('\n    ')}`,
        )
    }
  const waits = []
  for (const r of result.rows)
    for (const [k, t] of STEPS) {
      const c = r.cells[k]
      if (c?.status === 'pending') waits.push(`${r.name} · ${t}（${c.observed ?? c.text}）`)
    }
  if (problems.length > 0) lines.push('', '没过的（原始错误）：', ...problems)
  if (waits.length > 0)
    lines.push(
      '',
      `等 WP287 的 ${waits.length} 格（不算失败）：`,
      ...waits.slice(0, 4).map((w) => `- ${w}`),
      ...(waits.length > 4 ? [`- …共 ${waits.length} 格`] : []),
    )
  lines.push(
    '',
    `${result.ok ? '✓ 冒烟通过，可以装包' : '✗ 冒烟没过，不要装包'}（${Math.round(result.ms / 1000)} 秒）`,
  )
  return lines.join('\n')
}

// ── 命令行 ─────────────────────────────────────────────────────────────────

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${errText(e)}\n`)
    process.exit(2)
  }
  if (args.help) {
    process.stdout.write(`${readUsage()}\n`)
    return
  }
  const target = resolveServer({ app: args.app })
  if (target === undefined) {
    process.stderr.write(
      args.app === undefined
        ? '找不到 apps/server/dist/index.js——先 `npx tsc -b`。\n'
        : `在 ${args.app} 里找不到打好的服务端（<resources>/app/node_modules/@agentsws/server/dist/index.js）。\n`,
    )
    process.exit(2)
  }
  // 打好的产物：原生模块按捆绑 Node 的 ABI 编的——换成捆绑的 Node 重跑自己
  if (
    target.node !== undefined &&
    resolve(process.execPath) !== resolve(target.node) &&
    process.env.AGENTSWS_SMOKE_REEXEC !== '1'
  ) {
    const out = spawnSync(target.node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, AGENTSWS_SMOKE_REEXEC: '1' },
    })
    process.exit(out.status ?? 2)
  }
  const log = (line) => process.stderr.write(`${line}\n`)
  log(`装包前冒烟：服务端 ${target.entry}`)
  let result
  try {
    const serverModule = await loadServer(target.entry)
    result = await runSmoke({
      serverModule,
      ...(target.profileDir === undefined ? {} : { profileDir: target.profileDir }),
      ...(args.dshMode === undefined ? {} : { dshMode: args.dshMode }),
      ...(args.positions === undefined ? {} : { positions: args.positions }),
      keep: args.keep,
      log,
    })
  } catch (e) {
    process.stderr.write(`冒烟起不来：${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    process.exit(2)
  }
  process.stdout.write(`\n${renderTable(result)}\n`)
  if (args.json !== undefined) writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`)
  process.exit(result.ok ? 0 : result.rows.length === 0 ? 2 : 1)
}

function readUsage() {
  return [
    '用法：node scripts/preinstall-smoke.mjs [--app <打好的产物目录>] [--positions a,b] [--json 文件] [--keep]',
    '  不给 --app 就用当前构建（先 npx tsc -b）。退出码：0 过；1 有格没过；2 起不来。',
  ].join('\n')
}

const self = fileURLToPath(import.meta.url)
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === self.toLowerCase()
) {
  await main()
}
