/**
 * WP254（决策 100 / 123）：下载源「换国内源再试」。
 *
 * 假 npm 是真脚本、真子进程，`mirror_only` 模式冒充国内网络：源不是 npmmirror 一律 ENOTFOUND。
 * 钉住：默认官方源 → 网络失败（任务上记着用的官方源）→ 换国内源（每台机记住、重启服务进程还在）→
 * 同一个按钮再装就成；子进程拿到的源是国内源；下 npm 那一步也走国内源；连接器下载同理且锁文件照旧在场
 * （sha512 由 npm ci 按锁文件逐个校验）。不联网。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPEN_CONNECTOR_PIN, type OpenConnectorLockfile } from '@agentsws/connect-adapter'
import { PLATFORM_KITS, type PlatformCliSpec } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createNpmRegistryPreference,
  isNetworkFailure,
  NPM_REGISTRY_FILE,
  NPM_REGISTRY_URLS,
  withRegistry,
} from '../src/npm-registry.js'
import {
  createOpenConnectorInstaller,
  type OpenConnectorInstaller,
} from '../src/open-connector-installer.js'
import {
  type CliJobView,
  createPlatformCliRunner,
  type PlatformCliRunner,
} from '../src/platform-cli-runner.js'
import { writeFakeNpm } from './fixtures/fake-cli.js'
import { writeFakeOcNpm } from './fixtures/fake-oc-npm.js'

const SPEC = PLATFORM_KITS[0]?.cli as PlatformCliSpec
const MIRROR = 'https://registry.npmmirror.com'
const dirs: string[] = []
const runners: PlatformCliRunner[] = []
const installers: OpenConnectorInstaller[] = []
afterEach(() => {
  for (const r of runners.splice(0)) r.cancel(SPEC.id)
  for (const i of installers.splice(0)) i.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wp254-reg-'))
  dirs.push(d)
  return d
}
const now = (): string => new Date().toISOString()

async function settleCli(runner: PlatformCliRunner): Promise<CliJobView> {
  for (let i = 0; i < 400; i += 1) {
    const job = runner.job(SPEC.id)
    if (job !== undefined && ['done', 'failed', 'cancelled'].includes(job.phase)) return job
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('没结束')
}

describe('每台机一份的下载源', () => {
  it('默认官方源；改成国内源之后另起一个进程照样记得；坏文件当官方源', () => {
    const tools = tmp()
    const a = createNpmRegistryPreference({ toolsDir: tools, now, env: {} })
    expect(a.get()).toMatchObject({ source: 'official', env_override: false })
    expect(a.choose()).toEqual({ source: 'official' })
    a.set('npmmirror')
    const b = createNpmRegistryPreference({ toolsDir: tools, now, env: {} })
    expect(b.get().source).toBe('npmmirror')
    expect(b.choose()).toEqual({ source: 'npmmirror', url: NPM_REGISTRY_URLS.npmmirror })
    expect(JSON.parse(readFileSync(join(tools, NPM_REGISTRY_FILE), 'utf8')).source).toBe(
      'npmmirror',
    )
    b.set('official')
    expect(createNpmRegistryPreference({ toolsDir: tools, now, env: {} }).choose()).toEqual({
      source: 'official',
    })
  })

  it('优先级：点过国内源 > 环境里自己设的源 > 官方源（不写变量）', () => {
    const env = { npm_config_registry: 'https://npm.corp.example/' }
    const p = createNpmRegistryPreference({ toolsDir: undefined, now, env })
    expect(p.get().env_override).toBe(true)
    expect(p.choose()).toEqual({ source: 'custom', url: 'https://npm.corp.example/' })
    p.set('npmmirror')
    expect(p.choose()).toEqual({ source: 'npmmirror', url: MIRROR })
  })

  it('子进程环境：选了源就覆盖（大写那个删掉）；官方源一个字不动', () => {
    const base = { PATH: '/bin', NPM_CONFIG_REGISTRY: 'https://old.example' }
    expect(withRegistry(base, { source: 'official' })).toBe(base)
    expect(withRegistry(base, { source: 'npmmirror', url: MIRROR })).toEqual({
      PATH: '/bin',
      npm_config_registry: MIRROR,
    })
  })

  it('只有网络类失败给「换国内源再试」', () => {
    expect(isNetworkFailure('network')).toBe(true)
    expect(isNetworkFailure('timeout')).toBe(true)
    for (const code of ['integrity', 'disk_full', 'permission', 'failed', undefined])
      expect(isNetworkFailure(code)).toBe(false)
  })
})

describe('一键安装 CLI：网络失败 → 换国内源再试', () => {
  it('官方源连不上 → 任务记着用的官方源；换国内源后同一个按钮装上，npm 与子进程都走国内源', async () => {
    const root = tmp()
    const fake = writeFakeNpm(root, 'mirror_only')
    const toolsDir = join(root, 'data', 'tools')
    const pref = createNpmRegistryPreference({ toolsDir, now, env: {} })
    const npmRegistries: (string | undefined)[] = []
    const runner = createPlatformCliRunner({
      now,
      toolsDir,
      env: { PATH: '/usr/bin:/bin', HOME: root },
      registry: () => pref.choose(),
      npmCli: async (_onDownload, registry) => {
        npmRegistries.push(registry)
        return fake.npmCli
      },
    })
    runners.push(runner)

    runner.start(SPEC, 'install')
    const first = await settleCli(runner)
    expect(first).toMatchObject({
      phase: 'failed',
      registry: 'official',
      error: { code: 'network', detail: 'ENOTFOUND' },
    })

    // 卡上「换国内源再试」= PUT 国内源 + 再装一次
    pref.set('npmmirror')
    runner.start(SPEC, 'install')
    const second = await settleCli(runner)
    expect(second).toMatchObject({ phase: 'done', registry: 'npmmirror' })
    // 下 npm 那一步（随包没带时）也走国内源；第一次没传源 = 用 npm 自己的默认（官方）
    expect(npmRegistries).toEqual([undefined, MIRROR])
  })
})

describe('下载连接器：网络失败 → 换国内源再试', () => {
  const LOCK: OpenConnectorLockfile = {
    name: 'agentsws-open-connector-host',
    lockfileVersion: 3,
    packages: {
      '': { name: 'agentsws-open-connector-host' },
      'node_modules/a': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
        integrity: 'sha512-x',
      },
    },
  }

  it('官方源 ENOTFOUND → network（记着官方源）；换国内源 → npm ci 带着国内源与锁文件装上', async () => {
    const root = tmp()
    const npm = writeFakeOcNpm(root, 'mirror_only')
    npm.setVersion(OPEN_CONNECTOR_PIN.version)
    const dataDir = join(root, 'data')
    const pref = createNpmRegistryPreference({ toolsDir: join(dataDir, 'tools'), now, env: {} })
    const installer = createOpenConnectorInstaller({
      dataDir,
      now,
      env: { PATH: '/usr/bin:/bin', HOME: root },
      registry: () => pref.choose(),
      npmCli: async () => npm.npmCli,
      lockfile: LOCK,
      verify: async () => undefined,
      stopWaitMs: 1000,
      sleep: async () => undefined,
    })
    installers.push(installer)
    const settle = async () => {
      for (let n = 0; n < 400; n += 1) {
        const s = installer.snapshot()
        if (s.job !== undefined && !['preparing', 'downloading', 'verifying'].includes(s.job.phase))
          return s
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error('没结束')
    }

    installer.install()
    const first = await settle()
    expect(first.job).toMatchObject({ phase: 'failed', registry: 'official' })
    expect(first.job?.error?.code).toBe('network')

    pref.set('npmmirror')
    installer.install()
    const second = await settle()
    expect(second.job).toMatchObject({ phase: 'done', registry: 'npmmirror' })
    expect(second.installed).toBe(OPEN_CONNECTOR_PIN.version)
    const calls = readFileSync(join(npm.dir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args: string[]; lock: boolean; registry?: string })
    expect(calls.map((c) => c.registry)).toEqual([undefined, MIRROR])
    // 换源不换校验：两次都是 npm ci + 锁文件在场
    for (const c of calls) {
      expect(c.args[0]).toBe('ci')
      expect(c.lock).toBe(true)
    }
  })
})
