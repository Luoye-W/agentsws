/**
 * WP245：工作台替用户跑平台 CLI 登记过的命令。假 npm / 假 shopify 是真脚本、真子进程
 * （跑在测试自己的 node 上），覆盖 装好 / 网络失败 / 登录成功 / 用户取消 / 超时；不联网、不碰全局。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { PLATFORM_KITS, type PlatformCliSpec } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { NpmRuntimeError } from '../src/npm-runtime.js'
import { createPlatformCliProber } from '../src/platform-cli.js'
import {
  type CliJobView,
  createPlatformCliRunner,
  type PlatformCliRunner,
  privateCliEntry,
  runEnv,
} from '../src/platform-cli-runner.js'
import { cliSessionAlias, cliSessionEnv, cliSessionHome } from '../src/platform-cli-session.js'
import { setLoginMode, writeFakeNpm } from './fixtures/fake-cli.js'

const SPEC = PLATFORM_KITS[0]?.cli as PlatformCliSpec
const dirs: string[] = []
const runners: PlatformCliRunner[] = []

afterEach(() => {
  for (const r of runners.splice(0)) r.cancel(SPEC.id)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function machine(
  opts: {
    npmMode?: 'ok' | 'enotfound' | 'hang'
    npmCli?: (onDownload: () => void) => Promise<string>
    installTimeoutMs?: number
    loginTimeoutMs?: number
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'wp245-'))
  dirs.push(root)
  const fake = writeFakeNpm(root, opts.npmMode ?? 'ok')
  const toolsDir = join(root, 'data', 'tools')
  const finished: CliJobView[] = []
  let loggedIn = 0
  const runner = createPlatformCliRunner({
    now: () => new Date().toISOString(),
    toolsDir,
    // 只给白名单里的几个：PATH 不含任何 shopify，证明调的是私有安装
    env: { PATH: '/usr/bin:/bin', HOME: root },
    npmCli: opts.npmCli ?? (async () => fake.npmCli),
    ...(opts.installTimeoutMs === undefined ? {} : { installTimeoutMs: opts.installTimeoutMs }),
    ...(opts.loginTimeoutMs === undefined ? {} : { loginTimeoutMs: opts.loginTimeoutMs }),
  })
  runners.push(runner)
  const ctx = {
    onLoginOk: () => {
      loggedIn += 1
    },
    onFinished: (job: CliJobView) => {
      finished.push(job)
    },
  }
  const settle = async (): Promise<CliJobView> => {
    for (let i = 0; i < 400; i += 1) {
      const job = runner.job(SPEC.id)
      if (job !== undefined && ['done', 'failed', 'cancelled'].includes(job.phase)) return job
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`没结束：${JSON.stringify(runner.job(SPEC.id))}`)
  }
  const until = async (pred: (j: CliJobView) => boolean): Promise<CliJobView> => {
    for (let i = 0; i < 400; i += 1) {
      const job = runner.job(SPEC.id)
      if (job !== undefined && pred(job)) return job
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`没等到：${JSON.stringify(runner.job(SPEC.id))}`)
  }
  return { root, toolsDir, runner, ctx, finished, settle, until, loggedIn: () => loggedIn }
}

describe('一键安装：装进应用自己的数据目录', () => {
  it('装好：私有安装可用、检测认它（source=app）、进度数到取回的包', async () => {
    const m = machine()
    const started = m.runner.start(SPEC, 'install', m.ctx)
    expect(started.phase).toBe('preparing')
    expect(started.command).toContain('npm install --prefix')
    expect(started.command).toContain('@shopify/cli@latest')
    const job = await m.settle()
    expect(job.phase).toBe('done')
    expect(job.fetched).toBe(3)
    expect(job.log.some((l) => l.includes('added 3 packages'))).toBe(true)
    const entry = privateCliEntry(m.toolsDir, SPEC)
    expect(entry).toBe(
      join(m.toolsDir, 'shopify-cli', 'node_modules', '@shopify', 'cli', 'bin', 'run.js'),
    )
    expect(m.finished.map((j) => j.phase)).toEqual(['done'])
    // 检测：优先私有安装，跑在我们自己的 node 上
    const inv = m.runner.invocation(SPEC)
    expect(inv).toEqual({ command: process.execPath, prefix: [entry], source: 'app' })
    const prober = createPlatformCliProber({
      now: () => new Date().toISOString(),
      env: { PATH: '/usr/bin:/bin' },
      invocation: (s) => m.runner.invocation(s),
    })
    const probe = await prober.probe(SPEC, { fresh: true })
    expect(probe).toMatchObject({ installed: true, version: '4.8.5', source: 'app', node_ok: true })
  })

  it('网络失败：npm 的 ENOTFOUND → network，带原始码；可以再点一次', async () => {
    const m = machine({ npmMode: 'enotfound' })
    m.runner.start(SPEC, 'install', m.ctx)
    const job = await m.settle()
    expect(job.phase).toBe('failed')
    expect(job.error).toEqual({ code: 'network', detail: 'ENOTFOUND' })
    expect(privateCliEntry(m.toolsDir, SPEC)).toBeUndefined()
    // 重试不报「上一件还没做完」
    expect(() => m.runner.start(SPEC, 'install', m.ctx)).not.toThrow()
    await m.settle()
  })

  it('下 npm 时网络不通：cause.code 挖出来（WP242 同一口径）', async () => {
    const m = machine({
      npmCli: async (onDownload) => {
        onDownload()
        throw new NpmRuntimeError('network', '下载 npm 失败', {
          cause: Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('getaddrinfo EAI_AGAIN registry.npmjs.org'), {
              code: 'EAI_AGAIN',
            }),
          }),
        })
      },
    })
    m.runner.start(SPEC, 'install', m.ctx)
    const job = await m.settle()
    expect(job.error).toEqual({ code: 'network', detail: 'EAI_AGAIN' })
  })

  it('超时：掐掉，说超时', async () => {
    const m = machine({ npmMode: 'hang', installTimeoutMs: 300 })
    m.runner.start(SPEC, 'install', m.ctx)
    expect((await m.until((j) => j.phase === 'installing')).phase).toBe('installing')
    const job = await m.settle()
    expect(job.phase).toBe('failed')
    expect(job.error?.code).toBe('timeout')
  })

  it('同一时间只跑一件；没有数据目录不能装', async () => {
    const m = machine({ npmMode: 'hang' })
    m.runner.start(SPEC, 'install', m.ctx)
    expect(() => m.runner.start(SPEC, 'install', m.ctx)).toThrow(/还没做完/)
    m.runner.cancel(SPEC.id)
    expect((await m.settle()).phase).toBe('cancelled')
    const none = createPlatformCliRunner({ now: () => '', toolsDir: undefined })
    expect(() => none.start(SPEC, 'install')).toThrow(/没有数据目录/)
  })
})

async function installed(opts: Parameters<typeof machine>[0] = {}) {
  const m = machine(opts)
  m.runner.start(SPEC, 'install', m.ctx)
  expect((await m.settle()).phase).toBe('done')
  const entry = privateCliEntry(m.toolsDir, SPEC) as string
  return { ...m, entry }
}

describe('一键登录：服务端起 auth login，网址交给工作台', () => {
  it('登录成功：解析出网址与确认码、不带 CI、结束后记「登好了」', async () => {
    const m = await installed()
    const started = m.runner.start(SPEC, 'login', m.ctx)
    expect(started.command).toContain('auth login')
    const waiting = await m.until((j) => j.login_url !== undefined)
    expect(waiting.phase).toBe('waiting_browser')
    expect(waiting.login_url).toBe(
      'https://accounts.shopify.com/activate-with-code?device_code%5Buser_code%5D=ABCD-EFGH',
    )
    expect(waiting.user_code).toBe('ABCD-EFGH')
    expect(waiting.browser_opened).toBeUndefined()
    const job = await m.settle()
    expect(job.phase).toBe('done')
    expect(m.loggedIn()).toBe(1)
    // 颜色码去掉了
    expect(job.log.join('\n')).not.toContain('\u001b')
  })

  it('老版本「按任意键打开浏览器」：替用户按一下', async () => {
    const m = await installed()
    setLoginMode(m.entry, 'presskey')
    m.runner.start(SPEC, 'login', m.ctx)
    const job = await m.settle()
    expect(job.phase).toBe('done')
    expect(job.login_url).toContain('https://accounts.shopify.com/')
  })

  it('用户取消：进程停掉、不记登录', async () => {
    const m = await installed()
    setLoginMode(m.entry, 'hang')
    m.runner.start(SPEC, 'login', m.ctx)
    await m.until((j) => j.login_url !== undefined)
    const cancelled = m.runner.cancel(SPEC.id)
    expect(cancelled?.action).toBe('login')
    const job = await m.settle()
    expect(job.phase).toBe('cancelled')
    expect(m.loggedIn()).toBe(0)
  })

  it('超时：掐掉、说超时；被拒：说被拒', async () => {
    const m = await installed({ loginTimeoutMs: 400 })
    setLoginMode(m.entry, 'hang')
    m.runner.start(SPEC, 'login', m.ctx)
    const job = await m.settle()
    expect(job.error?.code).toBe('timeout')
    setLoginMode(m.entry, 'denied')
    m.runner.start(SPEC, 'login', m.ctx)
    const denied = await m.settle()
    expect(denied.phase).toBe('failed')
    expect(denied.error?.code).toBe('denied')
    expect(m.loggedIn()).toBe(0)
  })
})

describe('WP253：登录带 --alias，会话按品牌分开（4.8.5 非交互登录的规矩）', () => {
  const logins = (entry: string): { args: string[]; home: string; appdata?: string }[] => {
    const file = join(entry, '..', 'logins.jsonl')
    return existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l) as { args: string[]; home: string; appdata?: string })
      : []
  }

  it('不带 --alias：假 CLI 照 4.8.5 那样一秒内报「Flag not specified: --alias」（防回归）', async () => {
    const m = await installed()
    const { login_alias_flag: _drop, ...noAlias } = SPEC
    m.runner.start(noAlias as PlatformCliSpec, 'login', m.ctx)
    const job = await m.settle()
    expect(job.phase).toBe('failed')
    expect(job.log.join('\n')).toContain('Flag not specified')
    expect(m.loggedIn()).toBe(0)
  })

  it('4.8.5 的两行输出：确认码与「Opened link…」网址都认出来，CLI 自己开了浏览器就不再开', async () => {
    const m = await installed()
    setLoginMode(m.entry, 'opened')
    m.runner.start(SPEC, 'login', m.ctx)
    const job = await m.settle()
    expect(job).toMatchObject({
      phase: 'done',
      user_code: 'ABCD-EFGH',
      login_url:
        'https://accounts.shopify.com/activate-with-code?device_code%5Buser_code%5D=ABCD-EFGH',
      browser_opened: true,
    })
  })

  it('两个品牌各登各的：别名 + 各自一份 CLI 配置目录；同一品牌重登不撞「选哪个账号」；重登失败挪回原来那份', async () => {
    const m = await installed()
    const sessionA = {
      alias: cliSessionAlias('ws_rollout'),
      home: cliSessionHome(m.toolsDir, SPEC.id, 'ws_rollout'),
    }
    const sessionB = {
      alias: cliSessionAlias('ws_inmo'),
      home: cliSessionHome(m.toolsDir, SPEC.id, 'ws_inmo'),
    }
    m.runner.start(SPEC, 'login', { ...m.ctx, session: sessionA })
    expect((await m.settle()).phase).toBe('done')
    m.runner.start(SPEC, 'login', { ...m.ctx, session: sessionB })
    expect((await m.settle()).phase).toBe('done')
    const seen = logins(m.entry)
    expect(seen[0]?.args).toEqual(['auth', 'login', '--alias', 'agentsws-ws_rollout'])
    expect(seen[0]?.home).toBe(sessionA.home)
    expect(seen[0]?.appdata).toBe(join(sessionA.home, 'AppData', 'Roaming'))
    expect(seen[1]?.home).toBe(sessionB.home)
    // 同一品牌再登一次：原来那份先挪开，空配置里重新登（共用一份的话这里会撞上「Failed to prompt」）
    m.runner.start(SPEC, 'login', { ...m.ctx, session: sessionA })
    expect((await m.settle()).phase).toBe('done')
    expect(existsSync(`${sessionA.home}.prev`)).toBe(false)
    expect(m.loggedIn()).toBe(3)
    // 重登被拒：原来那份挪回来（原来登着的品牌不变成没登录）
    writeFileSync(join(sessionA.home, 'marker'), 'old session')
    setLoginMode(m.entry, 'denied')
    m.runner.start(SPEC, 'login', { ...m.ctx, session: sessionA })
    expect((await m.settle()).phase).toBe('failed')
    expect(readFileSync(join(sessionA.home, 'marker'), 'utf8')).toBe('old session')
  })

  it('共用一份配置（不分品牌）时第二个账号登不进去——这就是要分开的理由', async () => {
    const m = await installed()
    m.runner.start(SPEC, 'login', { ...m.ctx, session: { alias: 'agentsws-ws_a' } })
    expect((await m.settle()).phase).toBe('done')
    m.runner.start(SPEC, 'login', { ...m.ctx, session: { alias: 'agentsws-ws_b' } })
    const second = await m.settle()
    expect(second.phase).toBe('failed')
    expect(second.log.join('\n')).toContain('Failed to prompt')
  })

  it('环境变量：三个平台的 CLI 配置目录都指到品牌那一份', () => {
    expect(cliSessionAlias('WS_19cx/../x')).toBe('agentsws-ws_19cx-x')
    const env = cliSessionEnv('/d/tools/shopify-cli-sessions/ws_a')
    expect(env.HOME).toBe('/d/tools/shopify-cli-sessions/ws_a')
    expect(env.APPDATA).toBe(join('/d/tools/shopify-cli-sessions/ws_a', 'AppData', 'Roaming'))
    expect(env.XDG_CONFIG_HOME).toBe(join('/d/tools/shopify-cli-sessions/ws_a', '.config'))
  })
})

describe('子进程环境（白名单）', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/a',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    AGENTSWS_SECRETS_KEY: 'never',
    DEEPSEEK_API_KEY: 'never',
  }
  it('登录：不带 CI（带了 CLI 就拒绝交互登录）、带代理、关遥测、PATH 最前面是我们的 node', () => {
    const out = runEnv(SPEC, env, { nodeExec: '/app/node/bin/node', action: 'login' })
    expect(out.CI).toBeUndefined()
    expect(out.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(out.SHOPIFY_CLI_NO_ANALYTICS).toBe('1')
    expect(out.PATH?.split(delimiter)[0]).toBe('/app/node/bin')
    expect(JSON.stringify(out)).not.toContain('never')
  })
  it('安装：npm 缓存放在工具目录、不查更新不审计；报版本：照旧 CI=1、不带代理', () => {
    const install = runEnv(SPEC, env, {
      nodeExec: '/app/node/bin/node',
      action: 'install',
      toolsDir: '/data/tools',
    })
    expect(install.npm_config_cache).toBe(join('/data/tools', 'npm-cache'))
    expect(install.npm_config_update_notifier).toBe('false')
    expect(install.CI).toBe('1')
    const version = runEnv(SPEC, env, { nodeExec: 'node', action: 'version' })
    expect(version.HTTPS_PROXY).toBeUndefined()
    expect(version.PATH).toBe('/usr/bin')
  })
})
