/**
 * WP267：替用户跑 Shopify CLI 不让它自己 `npm install -g` 升级。
 *
 * 4.8.5 的开关（读发行包核过）：收尾钩子里 `CI` 为真 / 配置 `autoUpgradeEnabled=false` 就不升级，没有专门的环境变量。
 * - 契约：Shopify 那一行登记 `autoupgrade_off`（非交互带 `CI`；交互命令前跑 `config autoupgrade off`）
 * - `ensureCliAutoUpgradeOff`：只在本品牌配置目录里跑、只跑一次、关不成不挡、永不抛
 * - 店铺授权（`store auth` 不能带 CI）之前先关；`store execute` 本来就带 CI
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformCliNoAutoUpgradeEnv, platformKitOf } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUTOUPGRADE_OFF_MARKER, ensureCliAutoUpgradeOff } from '../src/cli-autoupgrade.js'
import { cliSessionHome } from '../src/platform-cli-session.js'
import { createShopAdmin, createStoreAuthRunner, STORE_SESSION_CLI_ID } from '../src/shop-auth.js'
import { type CliResult, createRunCli, type RunCli } from '../src/shopify-theme.js'
import { fakeStoreCli } from './fixtures/fake-shopify-store.js'

const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp267-au-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('WP267 契约：Shopify CLI 的自动升级开关', () => {
  it('登记了 CI 与 config autoupgrade off；AI 终端那一包环境带 CI', () => {
    expect(spec.autoupgrade_off).toEqual({
      env: { CI: '1' },
      config_args: ['config', 'autoupgrade', 'off'],
    })
    expect(platformCliNoAutoUpgradeEnv()).toMatchObject({ CI: '1' })
  })
})

describe('WP267 ensureCliAutoUpgradeOff', () => {
  const stub = (code = 0) => {
    const calls: { args: readonly string[]; env: Record<string, string>; cwd: string }[] = []
    const run: RunCli = async (args, opts): Promise<CliResult> => {
      calls.push({ args, env: opts.env, cwd: opts.cwd })
      return { code, stdout: '', stderr: '' }
    }
    return { run, calls }
  }

  it('在本品牌目录里跑一次（带 CI、HOME 指过去），记标记；第二次不再跑', async () => {
    const home = join(dir, 'sessions', 'ws_a')
    const s = stub()
    expect(await ensureCliAutoUpgradeOff({ spec, home, run: s.run, env: { PATH: '/bin' } })).toBe(
      'off',
    )
    expect(s.calls[0]?.args).toEqual(['config', 'autoupgrade', 'off'])
    expect(s.calls[0]?.env).toMatchObject({ PATH: '/bin', CI: '1', HOME: home })
    expect(existsSync(join(home, AUTOUPGRADE_OFF_MARKER))).toBe(true)
    expect(await ensureCliAutoUpgradeOff({ spec, home, run: s.run, env: {} })).toBe('already')
    expect(s.calls).toHaveLength(1)
  })

  it('没有本品牌目录 / CLI 没登记开关 → 不跑；关不成 → failed、不记标记、下次再试、不抛', async () => {
    const s = stub()
    expect(await ensureCliAutoUpgradeOff({ spec, home: undefined, run: s.run, env: {} })).toBe(
      'skipped',
    )
    const { autoupgrade_off: _a, ...bare } = spec
    expect(await ensureCliAutoUpgradeOff({ spec: bare, home: dir, run: s.run, env: {} })).toBe(
      'skipped',
    )
    expect(s.calls).toEqual([])
    const bad = stub(2)
    const home = join(dir, 'h')
    expect(await ensureCliAutoUpgradeOff({ spec, home, run: bad.run, env: {} })).toBe('failed')
    expect(existsSync(join(home, AUTOUPGRADE_OFF_MARKER))).toBe(false)
    const boom: RunCli = async () => {
      throw new Error('ENOENT')
    }
    expect(await ensureCliAutoUpgradeOff({ spec, home, run: boom, env: {} })).toBe('failed')
  })
})

describe('WP267 店铺授权之前先关自动升级（假 shopify 真子进程）', () => {
  it('config autoupgrade off 在本品牌店铺会话目录、带 CI；store auth 本身不带 CI；再授权不重复关', async () => {
    const cli = fakeStoreCli(dir)
    const auth = createStoreAuthRunner({ now: () => new Date().toISOString() })
    const home = cliSessionHome(join(dir, 'tools'), STORE_SESSION_CLI_ID, 'ws_rollout')
    const a = createShopAdmin({
      workspace_id: 'ws_rollout',
      clock: { now: () => new Date().toISOString() },
      cliSpec: () => spec,
      probe: async () => ({
        installed: true,
        node_ok: true,
        min_node_major: 22,
        checked_at: new Date().toISOString(),
        version: '4.8.5',
        source: 'app' as const,
      }),
      invocation: () => ({ command: process.execPath, prefix: [cli.entry] }),
      sessionHome: home,
      store: async () => 'rollout-test.myshopify.com',
      setStore: async () => {},
      install: () => undefined,
      installJob: () => undefined,
      auth,
      run: createRunCli(() => ({ command: process.execPath, prefix: [cli.entry] })),
      env: { PATH: process.env.PATH },
    })
    try {
      const done = async () => {
        for (let i = 0; i < 200; i += 1) {
          if ((await a.view(['dtc.store'])).job?.phase === 'done') return
          await new Promise((r) => setTimeout(r, 25))
        }
        throw new Error('授权没结束')
      }
      await a.run('authorize', ['dtc.store'])
      await done()
      expect(cli.configCalls()).toEqual([
        { argv: ['config', 'autoupgrade', 'off'], home, ci: true },
      ])
      const authCall = cli.calls().find((c) => c.argv[1] === 'auth')
      expect(authCall?.ci).toBe(false)
      expect(authCall?.home).toBe(home)
      await a.run('authorize', ['site.shopify-theme', 'dtc.store'])
      expect(cli.configCalls()).toHaveLength(1)
    } finally {
      auth.dispose()
    }
  })
})
