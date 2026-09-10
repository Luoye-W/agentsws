/**
 * Shopify 主题工作（WP44 交付 4）：**主题这条路只走官方 CLI**。
 *
 * 为什么不走 Admin API：主题是一整棵文件树（Liquid 模板、section、CSS、JSON 设置），
 * 一次改动动的是几十个文件。Admin API 只能一个文件一个文件地 upsert，没有差异比对、
 * 没有本地预览、没有 `theme dev` 的热重载。Shopify 自己给主题开发的官方工具就是
 * `shopify theme`——12 §2 的建站岗位要的正是它那套：拉下来、改、推到**未发布副本**、
 * 拿预览链接给人看、点头之后再 publish。
 *
 * 还有一条更硬的理由（09-10 实查）：Admin GraphQL 里**确实有** `themePublish` 与
 * `themeFilesUpsert`（2024-10 起与 REST 达成 parity），但官方文档写明改主题需要
 * `write_themes` **外加 Shopify 的豁免（exemption request）**。CLI + Theme Access 密码
 * 这条路不用申请，对绝大多数商家是唯一走得通的。
 *
 * 四条纪律：
 *
 * 1. **未发布副本 = stage，publish = apply。** 12 §2 那句"未发布的主题副本就是 stage，
 *    预览链接就是审批材料"落在这里：`pushUnpublished()` 只造预览，不动线上；线上换主题
 *    只有一条路——一条 `publish_theme` 的变更（15 §2：**high 风险、永远 L1**）批下来之后
 *    由执行器调 `publish()`。这个模块自己**不判断该不该发**，它只提供两个动作。
 * 2. **凭据只经子进程的环境变量**，而且是白名单：除了 {@link PASSTHROUGH_ENV} 那几个
 *    跑得起 CLI 必需的变量，本进程的环境一律不传给子进程——`AGENTSWS_SECRETS_KEY`、
 *    `OOMOL_CONNECT_ADMIN_TOKEN`、模型 key 都不该让一个第三方 CLI 看见。
 * 3. **CLI 没装不是错误，是一条待办。** 非技术用户的机器上八成没有 `shopify`；
 *    这时候该在界面上给一句"跑这条命令装一下"，而不是甩一个 ENOENT。
 *    {@link ShopifyTheme.status} 就是给界面用的。
 * 4. 子进程的 stdout / stderr 在进事件与返回值之前先经 {@link scrubCliOutput} 抹一遍：
 *    CLI 出错时很爱把令牌回显在 URL 里。
 */
import { execFile, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock, Iso8601, ObjectRef } from '@agentsws/contracts'

/** 装 CLI 的那条命令（界面上原样显示，用户复制粘贴）。 */
export const THEME_CLI_INSTALL = 'npm i -g @shopify/cli'

/** CLI 认的非交互令牌环境变量（Theme Access 密码或应用的 Admin API 令牌）。 */
export const THEME_TOKEN_ENV = 'SHOPIFY_CLI_THEME_TOKEN'

/** CLI 认的店铺环境变量（省得每条命令都带 `--store`）。 */
export const THEME_STORE_ENV = 'SHOPIFY_FLAG_STORE'

/**
 * 允许透传给子进程的环境变量名。
 *
 * 只有这几个：没有 `PATH` 找不到 node / git，没有 `HOME` CLI 存不了缓存，
 * 没有 `TMPDIR` 解压不了主题包。**别往这张表里加东西**——每加一个都是一条
 * "我们的秘密可能被第三方 CLI 读到"的路。
 */
export const PASSTHROUGH_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SHELL',
  'SystemRoot', // Windows 上 node 起不来
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
]

export type ShopifyThemeErrorCode =
  | 'cli_missing'
  | 'no_token'
  | 'cli_failed'
  | 'timeout'
  | 'bad_output'
  | 'invalid_input'

export class ShopifyThemeError extends Error {
  readonly code: ShopifyThemeErrorCode
  readonly detail: string | undefined
  /** `cli_missing` 时带上装它的命令，界面直接显示。 */
  readonly install_command: string | undefined

  constructor(
    code: ShopifyThemeErrorCode,
    message: string,
    opts: { detail?: string; install_command?: string } = {},
  ) {
    super(message)
    this.name = 'ShopifyThemeError'
    this.code = code
    this.detail = opts.detail
    this.install_command = opts.install_command
  }
}

/** 一次子进程调用的结果。 */
export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/** 跑一条 `shopify …`（测试注入假 CLI）。 */
export type RunCli = (
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<CliResult>

/** 一个还在跑的子进程（`theme dev` 是长驻的）。 */
export interface ThemeProcess {
  onLine(cb: (line: string) => void): void
  stop(): void
  done: Promise<number>
}

export type SpawnCli = (
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string> },
) => ThemeProcess

export interface ThemeCliStatus {
  installed: boolean
  version?: string
  /** 没装时给人看的一句话。 */
  reason?: string
  /** 装它的命令；无论装没装都给，界面上"怎么装"那一栏要用。 */
  install_command: string
}

/** `theme list --json` 里我们要的那几个字段。 */
export interface ThemeSummary {
  id: string
  name: string
  /** `main` = 线上那一份；`unpublished` = 副本；`development` = `theme dev` 起的临时主题。 */
  role: string
  updated_at?: string
  preview_url?: string
}

export interface PushedTheme {
  theme_id: string
  theme_name: string
  /** 给人点开看的预览链接（审批材料）。 */
  preview_url?: string
  /** 本地工作副本在哪（人要自己看代码时用得上）。 */
  path: string
}

/**
 * 一条"把这份副本发布上线"的变更提案。
 *
 * **只是提案**：这个模块不建审批项、不写账本——那是交易控制模块的事。这里负责把
 * `before` / `after` 填成真的（`before` 取自 `theme list` 读到的线上主题，不是模型说的）。
 */
export interface ThemePublishProposal {
  kind: 'publish_theme'
  target: ObjectRef
  before: { theme_id: string; theme_name: string }
  after: { theme_id: string; theme_name: string; preview_url?: string }
  /** 15 §2：`publish_theme` 是 high 风险、hard_ceiling，永远 L1。 */
  risk_class: 'high'
  notes: string[]
  staged_at: Iso8601
}

export interface ShopifyThemeOptions {
  clock: Clock
  /** 工作区根目录；主题副本落在 `<workdir>/themes/<store>/`。 */
  workdir: string
  env?: NodeJS.ProcessEnv
  /**
   * 按店铺取 CLI 用的令牌。**只在真要跑命令的那一瞬间调一次**，
   * 值直接交给子进程的环境变量，本模块不留、不记、不回显。
   */
  tokenFor(shop: string): string | undefined
  run?: RunCli
  spawnProcess?: SpawnCli
  /** 单条命令的超时（毫秒）。主题推送要传几十个文件，默认给足。 */
  timeoutMs?: number
  /** 事件汇；payload 里只有店铺 / 主题 id / 命令名，没有令牌、没有原始输出。 */
  appendEvent?: (type: string, payload: Record<string, unknown>) => void
}

export interface ShopifyTheme {
  status(): Promise<ThemeCliStatus>
  /** 这家店的主题工作副本在哪（不存在就建出来）。 */
  workspaceOf(shop: string): string
  list(shop: string): Promise<ThemeSummary[]>
  /** 把线上主题（或指定的那一份）拉到本地工作副本。 */
  pull(input: { shop: string; theme_id?: string }): Promise<{ path: string }>
  /** 把本地工作副本推成一份**未发布**的主题；返回预览链接。 */
  pushUnpublished(input: { shop: string; name: string }): Promise<PushedTheme>
  /** 把某份主题设成线上主题。**只有审批过的 `publish_theme` 变更才该调它。** */
  publish(input: { shop: string; theme_id: string }): Promise<{ theme_id: string }>
  /** 起本地热重载预览（长驻）；返回预览地址与停止它的办法。 */
  startDev(input: {
    shop: string
    waitMs?: number
  }): Promise<{ url: string | undefined; stop(): void }>
  /** 组一条"发布这份副本"的变更提案（before 取自线上那一份）。 */
  proposePublish(input: { shop: string; pushed: PushedTheme }): Promise<ThemePublishProposal>
}

// ── 输出清洗 ───────────────────────────────────────────────────────────

/**
 * CLI 的输出进任何地方之前先抹一遍。
 *
 * Theme Access 密码长 `shptka_…`，应用令牌长 `shpat_…`；CLI 报错时会把整条 URL
 * （有时带 `?access_token=`）打出来。这里跟 `shopify-broker.ts` 的 `scrub()` 同一条纪律。
 */
export function scrubCliOutput(text: string): string {
  return text
    .replace(/shp(at|ca|pa|ss|tka)_[A-Za-z0-9_-]+/g, 'shp**_…')
    .replace(/(access_token|password|token)=[^\s&"']+/gi, '$1=…')
    .replace(/\b[0-9a-f]{32,}\b/gi, '…')
}

// ── 默认的子进程实现 ───────────────────────────────────────────────────

function defaultRun(): RunCli {
  return (args, opts) =>
    new Promise<CliResult>((resolve, reject) => {
      execFile(
        'shopify',
        [...args],
        { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err === null) {
            resolve({ code: 0, stdout, stderr })
            return
          }
          const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean }
          if (e.code === 'ENOENT') {
            reject(
              new ShopifyThemeError('cli_missing', '这台机器上没有 Shopify CLI', {
                install_command: THEME_CLI_INSTALL,
              }),
            )
            return
          }
          if (e.killed === true) {
            reject(new ShopifyThemeError('timeout', 'Shopify CLI 跑太久了，已经掐掉'))
            return
          }
          // 非零退出码不是异常，是"命令失败了"——把输出交回去，让调用方决定怎么说
          resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout, stderr })
        },
      )
    })
}

function defaultSpawn(): SpawnCli {
  return (args, opts) => {
    const child = spawn('shopify', [...args], { cwd: opts.cwd, env: opts.env })
    const listeners: ((line: string) => void)[] = []
    let buffer = ''
    const feed = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) for (const cb of listeners) cb(line)
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    return {
      onLine: (cb) => listeners.push(cb),
      stop: () => child.kill(),
      done: new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? 0))
        child.on('error', () => resolve(-1))
      }),
    }
  }
}

// ── 装配 ───────────────────────────────────────────────────────────────

/** 预览链接长这样：`https://<shop>?preview_theme_id=123` 或本地的 `http://127.0.0.1:9292`。 */
const URL_RE = /(https?:\/\/[^\s"'<>]+)/

export function createShopifyTheme(options: ShopifyThemeOptions): ShopifyTheme {
  const env = options.env ?? process.env
  const run = options.run ?? defaultRun()
  const spawnCli = options.spawnProcess ?? defaultSpawn()
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const emit = (type: string, payload: Record<string, unknown>): void => {
    options.appendEvent?.(type, payload)
  }

  /**
   * 给子进程的环境：白名单 + 这次要用的令牌与店铺。
   *
   * 注意 `token` 是参数进来的，不是从 `env` 里捞的——本进程的环境里压根不该有它。
   */
  const childEnv = (shop: string, token: string | undefined): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const key of PASSTHROUGH_ENV) {
      const value = env[key]
      if (typeof value === 'string') out[key] = value
    }
    // CLI 在 CI 模式下不问交互问题；我们没有终端可以回答它
    out.CI = '1'
    out.SHOPIFY_CLI_NO_ANALYTICS = '1'
    out[THEME_STORE_ENV] = shop
    if (token !== undefined && token !== '') out[THEME_TOKEN_ENV] = token
    return out
  }

  const workspaceOf = (shop: string): string => {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(shop)) {
      throw new ShopifyThemeError('invalid_input', `店铺域名看不懂：${shop}`)
    }
    const dir = join(options.workdir, 'themes', shop)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 跑一条需要凭据的命令。没有令牌就别跑——跑了也只会拿到一句英文的 401。 */
  const runAuthed = async (shop: string, args: readonly string[]): Promise<CliResult> => {
    const token = options.tokenFor(shop)
    if (token === undefined || token === '') {
      throw new ShopifyThemeError(
        'no_token',
        `还没有 ${shop} 的主题访问凭据。先在连接页把这家店接上（Dev Dashboard 应用），` +
          '或者在 Shopify 后台装 Theme Access 应用生成一个主题密码。',
      )
    }
    const cwd = workspaceOf(shop)
    const result = await run(args, { cwd, env: childEnv(shop, token), timeoutMs })
    emit('shopify.theme_command', {
      shop,
      // 只记命令名与结果，不记参数值（参数里可能有主题名，那不是秘密，但也没必要）
      command: args.slice(0, 2).join(' '),
      exit_code: result.code,
    })
    if (result.code !== 0) {
      throw new ShopifyThemeError('cli_failed', cliFailureMessage(args, result), {
        detail: scrubCliOutput(`${result.stdout}\n${result.stderr}`).trim().slice(0, 600),
      })
    }
    return result
  }

  const parseJson = (text: string, what: string): unknown => {
    // CLI 会在 JSON 前面打几行进度条；从第一个 `[` 或 `{` 开始截
    const at = text.search(/[[{]/)
    if (at < 0) throw new ShopifyThemeError('bad_output', `${what}：CLI 没有回 JSON`)
    try {
      return JSON.parse(text.slice(at)) as unknown
    } catch {
      throw new ShopifyThemeError('bad_output', `${what}：CLI 回的 JSON 读不懂`)
    }
  }

  const list = async (shop: string): Promise<ThemeSummary[]> => {
    const result = await runAuthed(shop, ['theme', 'list', '--json'])
    const parsed = parseJson(result.stdout, '列主题')
    const rows = Array.isArray(parsed)
      ? parsed
      : ((parsed as { themes?: unknown }).themes ?? undefined)
    if (!Array.isArray(rows)) throw new ShopifyThemeError('bad_output', '列主题：回的不是一个数组')
    return rows.map(toThemeSummary).filter((t): t is ThemeSummary => t !== undefined)
  }

  return {
    workspaceOf,

    async status() {
      try {
        const result = await run(['version'], {
          cwd: options.workdir,
          env: childEnv('placeholder.myshopify.com', undefined),
          timeoutMs: 30_000,
        })
        if (result.code !== 0) {
          return {
            installed: false,
            reason: 'Shopify CLI 在这台机器上跑不起来（`shopify version` 没有正常退出）',
            install_command: THEME_CLI_INSTALL,
          }
        }
        const version = result.stdout.trim().split('\n')[0]?.trim()
        return {
          installed: true,
          ...(version === undefined || version === '' ? {} : { version }),
          install_command: THEME_CLI_INSTALL,
        }
      } catch (e) {
        if (e instanceof ShopifyThemeError && e.code === 'cli_missing') {
          return {
            installed: false,
            reason:
              '这台机器上还没装 Shopify CLI。主题的拉取、预览与发布都靠它——' +
              '在终端里跑一次下面这条命令就行（要先有 Node.js）。',
            install_command: THEME_CLI_INSTALL,
          }
        }
        throw e
      }
    },

    list,

    async pull({ shop, theme_id }) {
      // 09-10 实查 CLI 4.8 的 flag 表：`theme pull` **没有** `--force`（那是 publish 才有的），
      // 非交互时必须三选一给出 `--live` / `--development` / `--theme <id>`，否则它会问人。
      const args =
        theme_id === undefined
          ? ['theme', 'pull', '--live']
          : ['theme', 'pull', '--theme', theme_id]
      await runAuthed(shop, args)
      return { path: workspaceOf(shop) }
    },

    async pushUnpublished({ shop, name }) {
      if (name.trim() === '') {
        throw new ShopifyThemeError('invalid_input', '未发布主题得有个名字，人在后台要认得出它')
      }
      // `--unpublished` 是这条路的全部意义：推上去的是一份**副本**，线上一个字节都不动
      const result = await runAuthed(shop, [
        'theme',
        'push',
        '--unpublished',
        '--theme',
        name,
        '--json',
      ])
      const parsed = parseJson(result.stdout, '推送主题') as Record<string, unknown>
      const theme = (parsed.theme ?? parsed) as Record<string, unknown>
      const id = theme.id
      const theme_id = typeof id === 'number' ? String(id) : typeof id === 'string' ? id : undefined
      if (theme_id === undefined) {
        throw new ShopifyThemeError('bad_output', '推送主题：CLI 没有回新主题的 id')
      }
      const preview = pickUrl(theme, result.stdout)
      emit('shopify.theme_pushed', { shop, theme_id, unpublished: true })
      return {
        theme_id,
        theme_name: typeof theme.name === 'string' ? theme.name : name,
        ...(preview === undefined ? {} : { preview_url: preview }),
        path: workspaceOf(shop),
      }
    },

    async publish({ shop, theme_id }) {
      // `-f --force` 跳过那句"确认要发布吗"——我们没有终端可以回答它。
      // 人的那一次点头发生在**审批项**上，不在这个子进程里。
      await runAuthed(shop, ['theme', 'publish', '--theme', theme_id, '--force'])
      emit('shopify.theme_published', { shop, theme_id })
      return { theme_id }
    },

    async startDev({ shop, waitMs = 30_000 }) {
      const token = options.tokenFor(shop)
      if (token === undefined || token === '') {
        throw new ShopifyThemeError('no_token', `还没有 ${shop} 的主题访问凭据，起不了本地预览`)
      }
      const child = spawnCli(['theme', 'dev'], {
        cwd: workspaceOf(shop),
        env: childEnv(shop, token),
      })
      const url = await new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), waitMs)
        // 计时器不该拦着进程退出
        ;(timer as { unref?: () => void }).unref?.()
        child.onLine((line) => {
          const hit = URL_RE.exec(scrubCliOutput(line))?.[1]
          if (hit !== undefined) {
            clearTimeout(timer)
            resolve(hit)
          }
        })
        void child.done.then(() => {
          clearTimeout(timer)
          resolve(undefined)
        })
      })
      emit('shopify.theme_dev_started', { shop, has_url: url !== undefined })
      return { url, stop: () => child.stop() }
    },

    async proposePublish({ shop, pushed }) {
      const themes = await list(shop)
      const live = themes.find((t) => t.role === 'main')
      if (live === undefined) {
        throw new ShopifyThemeError('bad_output', `${shop} 上找不到线上主题，不敢提发布`)
      }
      return {
        kind: 'publish_theme',
        target: { type: 'theme', id: pushed.theme_id },
        // `before` 来自刚才那次真读，不是模型转述（15 §1 字段纪律）
        before: { theme_id: live.id, theme_name: live.name },
        after: {
          theme_id: pushed.theme_id,
          theme_name: pushed.theme_name,
          ...(pushed.preview_url === undefined ? {} : { preview_url: pushed.preview_url }),
        },
        risk_class: 'high',
        notes: [
          `把线上主题从「${live.name}」换成「${pushed.theme_name}」`,
          pushed.preview_url === undefined
            ? '预览链接没拿到，批准前请自己在后台点开这份副本看一眼'
            : `批准前先点开预览看一眼：${pushed.preview_url}`,
        ],
        staged_at: options.clock.now(),
      }
    },
  }
}

// ── 小工具 ─────────────────────────────────────────────────────────────

function toThemeSummary(row: unknown): ThemeSummary | undefined {
  if (row === null || typeof row !== 'object') return undefined
  const r = row as Record<string, unknown>
  const id = typeof r.id === 'number' ? String(r.id) : typeof r.id === 'string' ? r.id : undefined
  if (id === undefined) return undefined
  const preview = pickUrl(r, '')
  return {
    id,
    name: typeof r.name === 'string' ? r.name : id,
    role: typeof r.role === 'string' ? r.role : 'unpublished',
    ...(typeof r.updated_at === 'string' ? { updated_at: r.updated_at } : {}),
    ...(preview === undefined ? {} : { preview_url: preview }),
  }
}

/** 从 JSON 字段里挑预览链接，挑不到就从整段输出里捞第一条 URL。 */
function pickUrl(row: Record<string, unknown>, fallbackText: string): string | undefined {
  for (const key of ['preview_url', 'previewUrl', 'preview', 'url']) {
    const value = row[key]
    if (typeof value === 'string' && value.startsWith('http')) return value
  }
  return URL_RE.exec(scrubCliOutput(fallbackText))?.[1]
}

/** 命令失败时的人话。CLI 的英文原文只进 `detail`。 */
function cliFailureMessage(args: readonly string[], result: CliResult): string {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
  const what = args[1] ?? args[0] ?? '命令'
  if (text.includes('401') || text.includes('unauthorized') || text.includes('invalid api key')) {
    return `Shopify 不认这套主题凭据（${what}）。多半是令牌过期或权限里没勾主题读写；回连接页重新接一次这家店。`
  }
  if (text.includes('403') || text.includes('forbidden')) {
    return `这套凭据没有改主题的权限（${what}）。应用的权限里要有 read_themes / write_themes。`
  }
  if (text.includes('404') || text.includes('not found')) {
    return `找不到要操作的主题（${what}）。它可能已经被人在后台删掉了；刷新一下主题列表。`
  }
  if (text.includes('429') || text.includes('rate limit')) {
    return `Shopify 说请求太频繁了（${what}），等一会儿再来一次。`
  }
  return `Shopify CLI 的 ${what} 没成功（退出码 ${result.code}）。下面是它自己说的原因。`
}
