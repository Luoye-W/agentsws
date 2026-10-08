/**
 * WP261（决策 175 第 1 步）：**店铺授权**——岗位页「授权管理商品和页面」那一行的服务端（一个品牌一份）。
 *
 * | 这一跳 | 怎么做 |
 * |---|---|
 * | CLI 在哪 | WP245 的私有安装（`<data>/tools/shopify-cli`，用我们自己的 node 起）；系统全局的也认；没装 →「一键安装」 |
 * | 哪家店 | 与网页模板同一份（连接 → 登录后自动找到的 / 手填的 → 官网读到的 `xxx.myshopify.com`） |
 * | 授权 | 起 `shopify store auth --json --store <店> --scopes <岗位职责要的并集>`：CLI 自己开浏览器到店铺后台的授权页，
 *   人点批准，CLI 在本机 `127.0.0.1:13387` 收回调、换令牌、存进**本品牌那一份**会话目录 |
 * | 会话目录 | `<data>/tools/shopify-cli-store-sessions/<品牌>/`（HOME / APPDATA / XDG_* 都指过去，同 WP253）——
 *   与 `auth login` 那一份分开：重新登录 Shopify 账号时那一份会被挪走重建，不能把店铺授权一起挪掉 |
 * | 记什么 | 只记 CLI 打出来的「权限 + 何时授权 + 何时过期 + 有没有续期令牌」（`shop-admin.json`）；**令牌不经我们** |
 * | 过期 / 缺权限 | 按时间算（没有续期令牌时到点就过期）+ 执行时 CLI 的报错（过期 / 被收回 / 缺权限）→ 那一行回到「重新授权」 |
 *
 * 回调端口是整台电脑一个（13387），所以**同一时间只有一个品牌在授权**（{@link createStoreAuthRunner} 是进程级的一份）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { ShopAdminAuthJob, ShopAdminView } from '@agentsws/api'
import {
  type Clock,
  expandStoreScopes,
  type PlatformCliSpec,
  type PlatformStoreAdminSpec,
  storeAdminAllScopes,
  storeAdminScopesFor,
} from '@agentsws/contracts'
import type { PlatformCliProbe } from './platform-cli.js'
import {
  type CliJobView,
  cleanLine,
  defaultSpawnTool,
  runEnv,
  type SpawnTool,
  type ToolProcess,
} from './platform-cli-runner.js'
import { cliSessionEnv } from './platform-cli-session.js'
import {
  AUTH_PROBLEM_CODES,
  createCliShopifyAdmin,
  SHOP_ADMIN_TEXT,
  type ShopAdminError,
  ShopAdminError as ShopAdminErrorClass,
  type ShopifyAdmin,
  type ShopifyAdminReader,
} from './shop-admin.js'
import type { RunCli } from './shopify-theme.js'

/** CLI 的会话目录用这个名字分开（`<tools>/shopify-cli-store-sessions/<品牌>`）。 */
export const STORE_SESSION_CLI_ID = 'shopify-cli-store'

/** CLI 等回调 5 分钟；我们多给一分钟再掐。 */
const AUTH_TIMEOUT_MS = 6 * 60 * 1000
/** 与 CLI 判过期同一个提前量（4 分钟）。 */
const EXPIRY_MARGIN_MS = 4 * 60 * 1000

/** CLI `store auth --json` 回的那一段里我们记的几样（没有令牌）。 */
export interface ShopGrant {
  store: string
  scopes: string[]
  acquired_at: string
  expires_at?: string
  refresh_expires_at?: string
  /** 拿到了续期令牌：CLI 每次执行时到期前自己续。 */
  refreshable: boolean
}

interface ShopProblem {
  store: string
  code: 'expired' | 'revoked' | 'missing_scope'
  missing?: string[]
  at: string
}

interface ShopAdminFile {
  version: 1
  grants: Record<string, ShopGrant>
  problem?: ShopProblem
}

/** `store auth --json` 的输出 → 记下来的那一份（认不出回 undefined）。 */
export function grantOf(lines: readonly string[], fallbackStore: string): ShopGrant | undefined {
  const start = lines.findIndex((l) => l.trim() === '{')
  let end = -1
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i]?.trim() === '}') {
      end = i
      break
    }
  if (start < 0 || end < start) return undefined
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(lines.slice(start, end + 1).join('\n')) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!Array.isArray(raw.scopes)) return undefined
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined
  const expires = str(raw.expiresAt)
  const refreshExpires = str(raw.refreshTokenExpiresAt)
  return {
    store: str(raw.store) ?? fallbackStore,
    scopes: raw.scopes.filter((s): s is string => typeof s === 'string').sort(),
    acquired_at: str(raw.acquiredAt) ?? new Date().toISOString(),
    ...(expires === undefined ? {} : { expires_at: expires }),
    ...(refreshExpires === undefined ? {} : { refresh_expires_at: refreshExpires }),
    refreshable: raw.hasRefreshToken === true,
  }
}

/** 授权没成是哪一类（文案照 4.8.5 发行包原文）。 */
export function authFailure(lines: readonly string[]): NonNullable<ShopAdminAuthJob['error']> {
  const text = lines.join('\n')
  const oauth = /Shopify returned an OAuth error:\s*(\S+)/.exec(text)?.[1]
  if (oauth !== undefined) return { code: 'denied', detail: oauth }
  if (/Timed out waiting for OAuth callback/i.test(text)) return { code: 'timeout' }
  if (/Port \d+ is already in use/i.test(text)) return { code: 'port_busy' }
  if (/granted fewer scopes/i.test(text)) {
    const list = /Missing scopes:\s*([^\n]+)/i.exec(text)?.[1] ?? ''
    const missing = list
      .replace(/\.$/, '')
      .split(/[,\s]+/)
      .filter((s) => /^[a-z_]+$/.test(s))
    return { code: 'missing_scopes', missing }
  }
  if (/does not match the requested store/i.test(text)) return { code: 'store_mismatch' }
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|getaddrinfo/i.test(text))
    return { code: 'network' }
  return { code: 'failed' }
}

/** 授权网址只认 `https://<店>/admin/oauth/authorize?…`（CLI 开不了浏览器时打出来的那一行）。 */
export function authUrlOf(rawLine: string, store: string): string | undefined {
  const url = /(https:\/\/[^\s"'<>]+)/.exec(stripVTControlCharacters(rawLine))?.[1]
  if (url === undefined) return undefined
  try {
    const u = new URL(url)
    return u.hostname === store && u.pathname === '/admin/oauth/authorize'
      ? u.toString()
      : undefined
  } catch {
    return undefined
  }
}

// ── 进程级的授权跑法（同一时间只跑一个：回调端口整机一个） ───────────────

export interface StoreAuthStart {
  key: string
  store: string
  command: string
  args: readonly string[]
  env: Record<string, string>
  cwd: string
  onDone(
    result:
      | { ok: true; lines: string[] }
      | { ok: false; lines: string[]; cancelled?: boolean; timeout?: boolean },
  ): void
}

export interface StoreAuthRunner {
  /** 开始；别的品牌正在授权 → 回 `busy`。 */
  start(input: StoreAuthStart): ShopAdminAuthJob | 'busy'
  job(key: string): ShopAdminAuthJob | undefined
  cancel(key: string): void
  dispose(): void
}

export function createStoreAuthRunner(options: {
  now: () => string
  spawn?: SpawnTool
  timeoutMs?: number
}): StoreAuthRunner {
  const spawnTool = options.spawn ?? defaultSpawnTool()
  const jobs = new Map<string, ShopAdminAuthJob>()
  let current: { key: string; proc: ToolProcess; cancelled: boolean } | undefined
  return {
    start(input) {
      if (current !== undefined) return 'busy'
      const job: ShopAdminAuthJob = {
        action: 'authorize',
        phase: 'waiting_browser',
        started_at: options.now(),
      }
      jobs.set(input.key, job)
      mkdirSync(input.cwd, { recursive: true })
      const proc = spawnTool(input.command, input.args, { env: input.env, cwd: input.cwd })
      const run = { key: input.key, proc, cancelled: false }
      current = run
      const lines: string[] = []
      proc.onLine((raw) => {
        const url = authUrlOf(raw, input.store)
        if (url !== undefined) {
          job.auth_url = url
          job.browser_opened = false
        }
        const line = cleanLine(raw)
        if (line === '') return
        if (/will open the app authorization page/i.test(line) && job.auth_url === undefined)
          job.browser_opened = true
        if (/did not open automatically/i.test(line)) job.browser_opened = false
        lines.push(line)
        if (lines.length > 200) lines.splice(0, lines.length - 200)
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, options.timeoutMs ?? AUTH_TIMEOUT_MS)
      timer.unref?.()
      void proc.done.then((code) => {
        clearTimeout(timer)
        if (current === run) current = undefined
        job.finished_at = options.now()
        if (run.cancelled) {
          job.phase = 'cancelled'
          input.onDone({ ok: false, lines, cancelled: true })
          return
        }
        if (timedOut) {
          job.phase = 'failed'
          job.error = { code: 'timeout' }
          input.onDone({ ok: false, lines, timeout: true })
          return
        }
        if (code === 0) {
          job.phase = 'done'
          input.onDone({ ok: true, lines })
          return
        }
        job.phase = 'failed'
        job.error = authFailure(lines)
        input.onDone({ ok: false, lines })
      })
      return { ...job }
    },
    job: (key) => {
      const j = jobs.get(key)
      return j === undefined ? undefined : { ...j }
    },
    cancel(key) {
      if (current?.key !== key) return
      current.cancelled = true
      current.proc.kill()
    },
    dispose() {
      if (current === undefined) return
      current.cancelled = true
      current.proc.kill()
    },
  }
}

// ── 一个品牌一份 ─────────────────────────────────────────────────────────

export interface ShopAdminOptions {
  workspace_id: string
  clock: Clock
  /** 记授权结果的文件（`<品牌目录>/shop-admin.json`）；不给 = 只在内存里。 */
  settingsFile?: string
  /** 这个品牌的平台的 CLI 那一行（不是 Shopify = undefined）。 */
  cliSpec(): PlatformCliSpec | undefined
  probe(spec: PlatformCliSpec, fresh?: boolean): Promise<PlatformCliProbe>
  /** 怎么起 CLI（私有安装 → `<node> <入口>`；系统里的 → `shopify`）。 */
  invocation(spec: PlatformCliSpec): { command: string; prefix: readonly string[] }
  /** 本品牌那一份店铺授权的会话目录（`<tools>/shopify-cli-store-sessions/<品牌>`）；没有数据目录 = undefined。 */
  sessionHome?: string
  /** 这个品牌是哪家店（与网页模板同一份：连接 → 自动找到 / 手填 → 官网读到的）。 */
  store(): Promise<string | undefined>
  /** 人在那一行填的店铺地址（存进网页模板那一份设置）；地址不对抛错。 */
  setStore(raw: string): Promise<void>
  /** 一键安装（WP245 那一条）；正在跑别的 → 抛 `conflict`。 */
  install(spec: PlatformCliSpec): void
  installJob(spec: PlatformCliSpec): CliJobView | undefined
  auth: StoreAuthRunner
  /** 跑 `store execute` 的子进程（测试 / 演示注入假 CLI）。 */
  run: RunCli
  env?: NodeJS.ProcessEnv
  nodeExec?: string
  appendEvent?(type: string, payload: Record<string, unknown>): void
}

export interface ShopAccess {
  store: string
  /** 授权给过的权限（已展开 `write_x` → `read_x`）。 */
  scopes: string[]
}

export interface ShopAdminAssembly {
  view(roles: readonly string[]): Promise<ShopAdminView>
  run(action: 'install' | 'authorize', roles: readonly string[]): Promise<ShopAdminView>
  cancel(roles: readonly string[]): Promise<ShopAdminView>
  setStore(raw: string, roles: readonly string[]): Promise<ShopAdminView>
  /** 现在能不能用、能用哪些权限（工具面按它出现 / 隐藏）；没授权 / 过期 / 被收回 = undefined。 */
  access(): Promise<ShopAccess | undefined>
  /** AI 那一侧：只能查。不能用时抛 {@link ShopAdminError}（带人话）。 */
  reader(): Promise<ShopifyAdminReader>
  /** 执行器那一侧（人批过的卡）：查与改都行。 */
  admin(): Promise<ShopifyAdmin>
}

const isExpired = (g: ShopGrant, nowMs: number): boolean => {
  if (g.refreshable) {
    if (g.refresh_expires_at === undefined) return false
    const r = Date.parse(g.refresh_expires_at)
    return Number.isNaN(r) ? false : r - EXPIRY_MARGIN_MS < nowMs
  }
  if (g.expires_at === undefined) return false
  const e = Date.parse(g.expires_at)
  return Number.isNaN(e) ? true : e - EXPIRY_MARGIN_MS < nowMs
}

export function createShopAdmin(options: ShopAdminOptions): ShopAdminAssembly {
  const ws = options.workspace_id
  const env = options.env ?? process.env
  const nodeExec = options.nodeExec ?? process.execPath
  const now = (): string => options.clock.now()
  const emit = (type: string, payload: Record<string, unknown>): void => {
    try {
      options.appendEvent?.(type, { workspace_id: ws, ...payload })
    } catch {
      // 记事件失败不影响授权
    }
  }
  let memory: ShopAdminFile = { version: 1, grants: {} }
  const load = (): ShopAdminFile => {
    const file = options.settingsFile
    if (file === undefined || !existsSync(file)) return memory
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ShopAdminFile>
      memory = {
        version: 1,
        grants: raw.grants ?? {},
        ...(raw.problem === undefined ? {} : { problem: raw.problem }),
      }
    } catch {
      // 坏文件当没授权过（下一次授权会重写）
    }
    return memory
  }
  const save = (next: ShopAdminFile): void => {
    memory = next
    const file = options.settingsFile
    if (file === undefined) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  }
  const specs = (): { spec: PlatformCliSpec; sa: PlatformStoreAdminSpec } | undefined => {
    const spec = options.cliSpec()
    return spec?.store_admin === undefined ? undefined : { spec, sa: spec.store_admin }
  }
  /** 子进程环境：白名单 + 代理 + 关遥测 + 本品牌那一份会话目录。授权不带 `CI`（同登录）。 */
  const childEnv = (spec: PlatformCliSpec, forAuth: boolean): Record<string, string> => {
    const base = runEnv(spec, env, { nodeExec, action: 'login' })
    if (!forAuth) base.CI = '1'
    return options.sessionHome === undefined
      ? base
      : { ...base, ...cliSessionEnv(options.sessionHome) }
  }
  const noteProblem = (store: string, err: ShopAdminError): void => {
    if (!AUTH_PROBLEM_CODES.has(err.code)) return
    const code =
      err.code === 'missing_scope'
        ? 'missing_scope'
        : err.code === 'revoked'
          ? 'revoked'
          : 'expired'
    const file = load()
    save({
      ...file,
      problem: {
        store,
        code,
        ...(err.opts.missing === undefined ? {} : { missing: err.opts.missing }),
        at: now(),
      },
    })
    emit('shop_admin.problem', { code, missing: err.opts.missing?.length ?? 0 })
  }

  /** 这个品牌现在走到哪一档（`roles` 决定「要哪些权限」）。 */
  const compute = async (
    roles: readonly string[],
    fresh = false,
  ): Promise<ShopAdminView & { grant?: ShopGrant }> => {
    const s = specs()
    const needed = storeAdminScopesFor(s?.sa, roles)
    const empty = { scopes_needed: needed, scopes_granted: [], missing: [] }
    if (s === undefined || needed.length === 0) return { applicable: false, ...empty }
    const install = options.installJob(s.spec)
    const installJob: ShopAdminAuthJob | undefined =
      install === undefined || install.action !== 'install'
        ? undefined
        : {
            action: 'install',
            phase:
              install.phase === 'done' ||
              install.phase === 'failed' ||
              install.phase === 'cancelled'
                ? install.phase
                : 'running',
            started_at: install.started_at,
            ...(install.finished_at === undefined ? {} : { finished_at: install.finished_at }),
            ...(install.error === undefined
              ? {}
              : { error: { code: 'failed', detail: install.error.detail ?? install.error.code } }),
          }
    const probe = await options.probe(s.spec, fresh)
    if (!probe.installed || !probe.node_ok)
      return {
        applicable: true,
        state: 'no_cli',
        ...empty,
        ...(installJob === undefined ? {} : { job: installJob }),
      }
    const store = await options.store()
    if (store === undefined) return { applicable: true, state: 'no_store', ...empty }
    const file = load()
    const grant = file.grants[store]
    const job = options.auth.job(ws)
    const granted = grant === undefined ? [] : expandStoreScopes(grant.scopes)
    const missing = needed.filter((x) => !expandStoreScopes([x]).every((y) => granted.includes(y)))
    const problem =
      file.problem !== undefined &&
      file.problem.store === store &&
      (grant === undefined || Date.parse(file.problem.at) >= Date.parse(grant.acquired_at))
        ? file.problem
        : undefined
    const base = {
      applicable: true,
      store,
      scopes_needed: needed,
      scopes_granted: granted,
      missing,
      ...(grant === undefined
        ? {}
        : {
            authorized_at: grant.acquired_at,
            ...(grant.expires_at === undefined ? {} : { expires_at: grant.expires_at }),
            refreshable: grant.refreshable,
            grant,
          }),
      ...(problem === undefined ? {} : { problem }),
      ...(job === undefined ? {} : { job }),
    }
    if (job?.phase === 'waiting_browser') return { ...base, state: 'authorizing' }
    if (grant === undefined) return { ...base, state: 'unauthorized' }
    if (problem !== undefined && problem.code !== 'missing_scope')
      return { ...base, state: 'expired' }
    if (isExpired(grant, Date.parse(now()))) return { ...base, state: 'expired' }
    if (problem?.code === 'missing_scope') {
      const extra = (problem.missing ?? []).filter((m) => !missing.includes(m))
      return { ...base, missing: [...missing, ...extra].sort(), state: 'missing_scopes' }
    }
    if (missing.length > 0) return { ...base, state: 'missing_scopes' }
    return { ...base, state: 'authorized' }
  }
  const strip = (v: ShopAdminView & { grant?: ShopGrant }): ShopAdminView => {
    const { grant: _g, ...rest } = v
    return rest
  }

  const authorize = async (roles: readonly string[]): Promise<void> => {
    const s = specs()
    if (s === undefined) return
    const v = await compute(roles)
    if (
      v.state === undefined ||
      v.state === 'no_cli' ||
      v.state === 'no_store' ||
      v.store === undefined
    )
      return
    if (v.state === 'authorizing') return
    const store = v.store
    // 只能取登记表里的权限：岗位要的 ∪ 以前给过的（CLI 自己也会把店里已有的并进来）
    const registry = new Set(storeAdminAllScopes(s.sa))
    const before = (v.grant?.scopes ?? []).filter((x) => registry.has(x))
    const scopes = [...new Set([...v.scopes_needed, ...before])]
      .filter((x) => registry.has(x))
      .sort()
    if (scopes.length === 0) return
    const how = options.invocation(s.spec)
    const home = options.sessionHome
    const started = options.auth.start({
      key: ws,
      store,
      command: how.command,
      args: [
        ...how.prefix,
        ...s.sa.auth_args,
        s.sa.store_flag,
        store,
        s.sa.scopes_flag,
        scopes.join(','),
      ],
      env: childEnv(s.spec, true),
      cwd: home ?? process.cwd(),
      onDone: (result) => {
        if (!result.ok) {
          const err = result.cancelled === true ? undefined : authFailure(result.lines)
          emit('shop_admin.auth_finished', {
            ok: false,
            ...(result.cancelled === true ? { cancelled: true } : { error: err?.code ?? 'failed' }),
          })
          return
        }
        const grant = grantOf(result.lines, store) ?? {
          store,
          scopes,
          acquired_at: now(),
          refreshable: false,
        }
        const file = load()
        const { problem: _p, ...rest } = file
        save({ ...rest, grants: { ...file.grants, [store]: { ...grant, store } } })
        emit('shop_admin.auth_finished', {
          ok: true,
          scopes: grant.scopes.length,
          refreshable: grant.refreshable,
          ...(grant.expires_at === undefined
            ? {}
            : {
                expires_in_minutes: Math.round(
                  (Date.parse(grant.expires_at) - Date.parse(grant.acquired_at)) / 60_000,
                ),
              }),
        })
      },
    })
    if (started === 'busy')
      throw new ShopAdminErrorClass('failed', '另一个品牌正在授权，等它好了再点。', {
        detail: 'busy',
      })
    emit('shop_admin.auth_started', { scopes: scopes.length })
  }

  const usable = async (): Promise<{
    store: string
    grant: ShopGrant
    s: NonNullable<ReturnType<typeof specs>>
  }> => {
    const s = specs()
    if (s === undefined) throw new ShopAdminErrorClass('failed', '这个品牌的建站平台不能这样管店。')
    const v = await compute(Object.keys(s.sa.scopes_by_role))
    if (v.state === 'no_cli')
      throw new ShopAdminErrorClass('cli_missing', SHOP_ADMIN_TEXT.cli_missing)
    if (v.state === 'no_store' || v.store === undefined)
      throw new ShopAdminErrorClass(
        'not_authorized',
        '还不知道是哪家店。请到岗位页填上店铺地址（xxx.myshopify.com）再授权。',
      )
    if (v.grant === undefined)
      throw new ShopAdminErrorClass('not_authorized', SHOP_ADMIN_TEXT.not_authorized)
    if (v.state === 'expired')
      throw new ShopAdminErrorClass(
        v.problem?.code === 'revoked' ? 'revoked' : 'expired',
        SHOP_ADMIN_TEXT[v.problem?.code === 'revoked' ? 'revoked' : 'expired'],
      )
    return { store: v.store, grant: v.grant, s }
  }
  const adminFor = (store: string, s: NonNullable<ReturnType<typeof specs>>): ShopifyAdmin =>
    createCliShopifyAdmin({
      store,
      spec: s.sa,
      run: options.run,
      env: () => childEnv(s.spec, false),
      ...(options.sessionHome === undefined ? {} : { workDir: join(options.sessionHome, 'work') }),
      onAuthProblem: (err) => noteProblem(store, err),
    })

  return {
    view: async (roles) => strip(await compute(roles)),
    async run(action, roles) {
      const s = specs()
      if (s === undefined) return strip(await compute(roles))
      if (action === 'install') {
        const v = await compute(roles, true)
        if (v.state === 'no_cli') options.install(s.spec)
        return strip(await compute(roles))
      }
      await authorize(roles)
      return strip(await compute(roles))
    },
    async cancel(roles) {
      options.auth.cancel(ws)
      return strip(await compute(roles))
    },
    async setStore(raw, roles) {
      await options.setStore(raw)
      return strip(await compute(roles))
    },
    async access() {
      try {
        const { store, grant } = await usable()
        const file = load()
        const problem =
          file.problem?.store === store &&
          file.problem.code === 'missing_scope' &&
          Date.parse(file.problem.at) >= Date.parse(grant.acquired_at)
            ? file.problem
            : undefined
        const scopes = expandStoreScopes(grant.scopes).filter(
          (x) => !(problem?.missing ?? []).includes(x),
        )
        return { store, scopes }
      } catch {
        return undefined
      }
    },
    async reader() {
      const { store, s } = await usable()
      const a = adminFor(store, s)
      return { via: a.via, store: a.store, query: a.query }
    },
    async admin() {
      const { store, s } = await usable()
      return adminFor(store, s)
    },
  }
}
