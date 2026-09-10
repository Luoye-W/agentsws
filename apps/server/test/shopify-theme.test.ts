/**
 * Shopify 主题工作（WP44 交付 4）。
 *
 * 测试用的是**一个真的子进程**：PATH 前面塞一个叫 `shopify` 的脚本，它把收到的
 * 参数和环境变量原样写进文件，再按剧本回一段 JSON。这样跑到的是真正的
 * `execFile` 那一跳——环境变量白名单、参数拼装、非零退出码的处理都被覆盖到，
 * 而不是对着一个注入的假函数自说自话。
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createShopifyTheme,
  PASSTHROUGH_ENV,
  type ShopifyTheme,
  ShopifyThemeError,
  scrubCliOutput,
  THEME_CLI_INSTALL,
  THEME_TOKEN_ENV,
} from '../src/shopify-theme.js'

const T0 = '2026-09-10T09:00:00.000Z'
const SHOP = 'demo.myshopify.com'
/** 测试里唯一的"凭据"。所有零泄漏断言都盯着这一串。 */
const THEME_TOKEN = 'shptka_never_logged_wp44_42'

let dir: string
let binDir: string
/** 假 CLI 把每次调用写进这个文件（一行一次，JSON）。 */
let logFile: string

interface CliCall {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

/** 装一个假 `shopify`：记参数与环境，再照 `script` 里的规则回话。 */
function installFakeCli(script: string): void {
  const path = join(binDir, 'shopify')
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(logFile)},
  JSON.stringify({ argv, cwd: process.cwd(), env: process.env }) + '\\n')
${script}
`,
    'utf8',
  )
  chmodSync(path, 0o755)
}

function calls(): CliCall[] {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as CliCall)
}

function makeTheme(overrides: { token?: string | undefined } = {}): ShopifyTheme {
  const events: { type: string; payload: Record<string, unknown> }[] = []
  const theme = createShopifyTheme({
    clock: { now: () => T0 },
    workdir: dir,
    // PATH 前面挂上假 CLI；别的环境变量照旧（白名单会自己筛）
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, AGENTSWS_SECRETS_KEY: 'x' },
    tokenFor: () => ('token' in overrides ? overrides.token : THEME_TOKEN),
    timeoutMs: 20_000,
    appendEvent: (type, payload) => events.push({ type, payload }),
  })
  ;(theme as { events?: typeof events }).events = events
  return theme
}

function eventsOf(theme: ShopifyTheme): { type: string; payload: Record<string, unknown> }[] {
  return (theme as { events?: { type: string; payload: Record<string, unknown> }[] }).events ?? []
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-theme-'))
  binDir = mkdtempSync(join(tmpdir(), 'agentsws-bin-'))
  logFile = join(dir, 'cli-calls.jsonl')
})

describe('WP44 §4 CLI 没装：给安装说明，不是甩一个 ENOENT', () => {
  it('status()：installed=false + 一条能直接复制的命令', async () => {
    // 不装假 CLI，PATH 里干脆没有 `shopify`
    const theme = createShopifyTheme({
      clock: { now: () => T0 },
      workdir: dir,
      env: { PATH: binDir },
      tokenFor: () => THEME_TOKEN,
    })
    const status = await theme.status()
    expect(status.installed).toBe(false)
    expect(status.install_command).toBe(THEME_CLI_INSTALL)
    expect(status.reason).toContain('Shopify CLI')
  })

  it('真去跑一条命令时抛 cli_missing，错误里也带着安装命令', async () => {
    const theme = createShopifyTheme({
      clock: { now: () => T0 },
      workdir: dir,
      env: { PATH: binDir },
      tokenFor: () => THEME_TOKEN,
    })
    await expect(theme.list(SHOP)).rejects.toMatchObject({
      code: 'cli_missing',
      install_command: THEME_CLI_INSTALL,
    })
  })

  it('装上之后 status() 报版本号', async () => {
    installFakeCli(`console.log('3.66.1')`)
    const status = await makeTheme().status()
    expect(status.installed).toBe(true)
    expect(status.version).toBe('3.66.1')
  })
})

describe('WP44 §4 凭据只经子进程环境变量，而且是白名单', () => {
  it('令牌进 SHOPIFY_CLI_THEME_TOKEN；本进程的秘密一个都不传下去', async () => {
    installFakeCli(`console.log(JSON.stringify([]))`)
    await makeTheme().list(SHOP)
    const call = calls()[0]
    if (call === undefined) throw new Error('假 CLI 没被调用')
    expect(call.env[THEME_TOKEN_ENV]).toBe(THEME_TOKEN)
    expect(call.env.SHOPIFY_FLAG_STORE).toBe(SHOP)
    // 白名单之外的一律没有：秘密库密钥、连接器管理令牌、模型 key
    expect(call.env.AGENTSWS_SECRETS_KEY).toBeUndefined()
    expect(call.env.OOMOL_CONNECT_ADMIN_TOKEN).toBeUndefined()
    expect(call.env.DEEPSEEK_API_KEY).toBeUndefined()
    // 传下去的键只可能是白名单 + 我们自己加的那四个
    const allowed = new Set([
      ...PASSTHROUGH_ENV,
      'CI',
      'SHOPIFY_CLI_NO_ANALYTICS',
      'SHOPIFY_FLAG_STORE',
      THEME_TOKEN_ENV,
    ])
    // macOS 的 libc 会自己往子进程里塞 `__CF_USER_TEXT_ENCODING`，那不是我们传的
    expect(Object.keys(call.env).filter((k) => !allowed.has(k) && !k.startsWith('__'))).toEqual([])
  })

  it('没有令牌就根本不起子进程（跑了也只会拿到一句英文 401）', async () => {
    installFakeCli(`console.log('[]')`)
    const theme = makeTheme({ token: undefined })
    await expect(theme.list(SHOP)).rejects.toMatchObject({ code: 'no_token' })
    expect(calls()).toEqual([])
  })

  it('事件里只有店铺与命令名，没有令牌', async () => {
    installFakeCli(`console.log('[]')`)
    const theme = makeTheme()
    await theme.list(SHOP)
    const events = eventsOf(theme)
    expect(events[0]?.type).toBe('shopify.theme_command')
    expect(events[0]?.payload.command).toBe('theme list')
    expect(JSON.stringify(events)).not.toContain(THEME_TOKEN)
  })
})

describe('WP44 §4 拉 / 推未发布 / 发布', () => {
  it('pull 默认拉线上那一份，落到 themes/<store>/', async () => {
    installFakeCli(`console.log('ok')`)
    const theme = makeTheme()
    const out = await theme.pull({ shop: SHOP })
    expect(out.path).toBe(join(dir, 'themes', SHOP))
    const call = calls()[0]
    // 09-10 实查：`theme pull` 没有 --force，非交互时必须三选一说清楚拉哪一份
    expect(call?.argv).toEqual(['theme', 'pull', '--live'])
    // cwd 就是那家店的工作副本目录（macOS 上 /var 是 /private/var 的软链，比后缀）
    expect(call?.cwd.endsWith(join('themes', SHOP))).toBe(true)
  })

  it('pull 指定主题时带 --theme', async () => {
    installFakeCli(`console.log('ok')`)
    await makeTheme().pull({ shop: SHOP, theme_id: '778899' })
    expect(calls()[0]?.argv).toEqual(['theme', 'pull', '--theme', '778899'])
  })

  it('pushUnpublished：一定带 --unpublished，回预览链接', async () => {
    installFakeCli(`
console.log('Pushing theme files…')
console.log(JSON.stringify({ theme: {
  id: 990011, name: '改价活动页 v3', role: 'unpublished',
  preview_url: 'https://demo.myshopify.com?preview_theme_id=990011',
} }))
`)
    const theme = makeTheme()
    const pushed = await theme.pushUnpublished({ shop: SHOP, name: '改价活动页 v3' })
    expect(calls()[0]?.argv).toEqual([
      'theme',
      'push',
      '--unpublished',
      '--theme',
      '改价活动页 v3',
      '--json',
    ])
    expect(pushed.theme_id).toBe('990011')
    expect(pushed.theme_name).toBe('改价活动页 v3')
    expect(pushed.preview_url).toContain('preview_theme_id=990011')
    expect(eventsOf(theme).some((e) => e.type === 'shopify.theme_pushed')).toBe(true)
  })

  it('publish 只做一件事：把某个 id 设成线上主题', async () => {
    installFakeCli(`console.log('published')`)
    const theme = makeTheme()
    await theme.publish({ shop: SHOP, theme_id: '990011' })
    expect(calls()[0]?.argv).toEqual(['theme', 'publish', '--theme', '990011', '--force'])
    expect(eventsOf(theme).some((e) => e.type === 'shopify.theme_published')).toBe(true)
  })

  it('CLI 401：中文说清楚"回连接页重接一次"，英文原文只进 detail 且已脱敏', async () => {
    installFakeCli(`
console.error('[401] Unauthorized: https://demo.myshopify.com/admin?access_token=shptka_never_logged_wp44_42')
process.exit(1)
`)
    const failed = await makeTheme()
      .list(SHOP)
      .catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(ShopifyThemeError)
    const err = failed as ShopifyThemeError
    expect(err.code).toBe('cli_failed')
    expect(err.message).toContain('重新接一次')
    // 上游原文进 detail，但令牌被抹掉了
    expect(err.detail).toContain('401')
    expect(err.detail).not.toContain(THEME_TOKEN)
    expect(JSON.stringify(err)).not.toContain(THEME_TOKEN)
  })

  it('店铺域名看不懂：一次子进程都不起', async () => {
    installFakeCli(`console.log('[]')`)
    await expect(makeTheme().list('../../etc/passwd')).rejects.toMatchObject({
      code: 'invalid_input',
    })
    expect(calls()).toEqual([])
  })
})

describe('WP44 §4 发布提案：before 来自真读，风险永远 high', () => {
  it('proposePublish 组出一条 publish_theme 提案，before 是线上那一份', async () => {
    installFakeCli(`
if (argv[1] === 'list') {
  console.log(JSON.stringify([
    { id: 111, name: '现行主题', role: 'main' },
    { id: 990011, name: '改价活动页 v3', role: 'unpublished' },
  ]))
} else {
  console.log('ok')
}
`)
    const theme = makeTheme()
    const proposal = await theme.proposePublish({
      shop: SHOP,
      pushed: {
        theme_id: '990011',
        theme_name: '改价活动页 v3',
        preview_url: 'https://demo.myshopify.com?preview_theme_id=990011',
        path: theme.workspaceOf(SHOP),
      },
    })
    expect(proposal.kind).toBe('publish_theme')
    // 15 §2：publish_theme 是 high、hard_ceiling，永远 L1
    expect(proposal.risk_class).toBe('high')
    expect(proposal.target).toEqual({ type: 'theme', id: '990011' })
    expect(proposal.before).toEqual({ theme_id: '111', theme_name: '现行主题' })
    expect(proposal.after.theme_id).toBe('990011')
    // 审批材料里一定要有预览链接，人才知道自己在批什么
    expect(proposal.notes.join('\n')).toContain('preview_theme_id=990011')
    expect(proposal.staged_at).toBe(T0)
  })

  it('线上主题都找不到就不敢提发布', async () => {
    installFakeCli(`console.log(JSON.stringify([{ id: 990011, name: 'x', role: 'unpublished' }]))`)
    await expect(
      makeTheme().proposePublish({
        shop: SHOP,
        pushed: { theme_id: '990011', theme_name: 'x', path: dir },
      }),
    ).rejects.toMatchObject({ code: 'bad_output' })
  })
})

describe('WP44 §4 本地预览（theme dev）', () => {
  it('起得来就回那条地址，stop() 能把它掐掉', async () => {
    const stopped: string[] = []
    const theme = createShopifyTheme({
      clock: { now: () => T0 },
      workdir: dir,
      env: { PATH: binDir },
      tokenFor: () => THEME_TOKEN,
      spawnProcess: (args, opts) => {
        const listeners: ((line: string) => void)[] = []
        setTimeout(() => {
          for (const cb of listeners) cb('Preview your theme: http://127.0.0.1:9292')
        }, 1)
        expect(args).toEqual(['theme', 'dev'])
        expect(opts.env[THEME_TOKEN_ENV]).toBe(THEME_TOKEN)
        return {
          onLine: (cb) => listeners.push(cb),
          stop: () => stopped.push('stopped'),
          done: new Promise<number>(() => {}),
        }
      },
    })
    const dev = await theme.startDev({ shop: SHOP, waitMs: 2000 })
    expect(dev.url).toBe('http://127.0.0.1:9292')
    dev.stop()
    expect(stopped).toEqual(['stopped'])
  })

  it('CLI 直接退了就回 url: undefined，不吊着调用方', async () => {
    const theme = createShopifyTheme({
      clock: { now: () => T0 },
      workdir: dir,
      env: { PATH: binDir },
      tokenFor: () => THEME_TOKEN,
      spawnProcess: () => ({
        onLine: () => {},
        stop: () => {},
        done: Promise.resolve(1),
      }),
    })
    expect((await theme.startDev({ shop: SHOP, waitMs: 5000 })).url).toBeUndefined()
  })
})

describe('WP44 §4 输出脱敏', () => {
  it('主题密码、访问令牌、URL 里的 token 一律抹掉', () => {
    const raw =
      'error: https://demo.myshopify.com/x?access_token=shptka_abc123 and shpat_deadbeefcafe1234'
    const clean = scrubCliOutput(raw)
    expect(clean).not.toContain('shptka_abc123')
    expect(clean).not.toContain('shpat_deadbeefcafe1234')
    expect(clean).toContain('access_token=…')
  })
})
