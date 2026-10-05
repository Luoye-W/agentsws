/**
 * WP216：`/v1/platform-kit*` 的服务端那一半 + 本机 CLI 检测。全部用替身：假 CLI（记录调用的
 * shell 脚本 / 注入的 exec），不连真店铺、不跑真的 `shopify`。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformKitOf, type StorefrontPlatform } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPlatformCliProber,
  defaultProbeExec,
  nodeMajorOk,
  PlatformCliLoginStore,
  type ProbeExec,
  parseVersion,
} from '../src/platform-cli.js'
import { cliStateOf, createPlatformKitPort, resolveBrandPlatform } from '../src/platform-kit.js'
import { DEV_MCP_ARGS } from '../src/shopify-devmcp.js'

const NOW = '2026-10-05T10:00:00.000Z'
const SHOPIFY_CLI = platformKitOf('shopify')?.cli
if (SHOPIFY_CLI === undefined) throw new Error('Shopify 那一行缺 CLI')

/** 记录调用的假 exec：`shopify` 回给定版本（或没装），`node` 回给定版本。 */
function fakeExec(state: { cli?: string; node?: string }): ProbeExec & {
  calls: { bin: string; args: readonly string[]; env: Record<string, string> }[]
} {
  const calls: { bin: string; args: readonly string[]; env: Record<string, string> }[] = []
  const exec = (async (bin, args, opts) => {
    calls.push({ bin, args, env: opts.env })
    const v = bin === 'node' ? state.node : state.cli
    return v === undefined ? { ok: false, stdout: '', missing: true } : { ok: true, stdout: v }
  }) as ProbeExec & { calls: typeof calls }
  exec.calls = calls
  return exec
}

/** 哪些品牌有人在做建站（网页模板）这条职责；缺省都有。 */
const ROLE_HOLDERS: Record<string, readonly string[]> = {}

function makePort(
  platforms: Record<string, StorefrontPlatform | undefined>,
  exec: ProbeExec,
): ReturnType<typeof createPlatformKitPort> {
  const stores = new Map<string, PlatformCliLoginStore>()
  return createPlatformKitPort({
    now: () => NOW,
    platformOf: (ws) => platforms[ws],
    setPlatform: (ws, p) => {
      if (ws === 'ws_noprofile') return false
      platforms[ws] = p
      return true
    },
    hasRoles: (ws, role_ids) =>
      role_ids.some((r) => (ROLE_HOLDERS[ws] ?? ['site.shopify-theme']).includes(r)),
    platformChoices: () => [
      { key: 'shopify', label: 'Shopify', supported: true },
      { key: 'none', label: '还没开始搭建', supported: true },
      { key: 'woocommerce', label: 'WooCommerce', supported: false },
    ],
    prober: createPlatformCliProber({ now: () => NOW, env: {}, exec }),
    loginStoreOf: (ws) => {
      let s = stores.get(ws)
      if (s === undefined) {
        s = new PlatformCliLoginStore(undefined)
        stores.set(ws, s)
      }
      return s
    },
    mcpStatus: () => ({ enabled: true, downloaded: false, tools: [] }),
  })
}

const actor = (ws: string) => ({ workspace_id: ws, person_id: 'per_1', assignment_id: 'asg_1' })

describe('WP216 平台套件：按品牌档案', () => {
  it('Shopify 品牌：有官方技能、Dev MCP、CLI 卡；没装 CLI 是「missing」并说明降级的职责', async () => {
    const exec = fakeExec({ node: 'v22.12.0' })
    const view = await makePort({ ws_a: 'shopify' }, exec).view(actor('ws_a'), {})
    expect(view.platform).toBe('shopify')
    expect(view.kit?.skills.map((s) => s.name)).toEqual(['shopify'])
    expect(view.kit?.skill_source).toMatchObject({
      repo: 'Shopify/Shopify-AI-Toolkit',
      license: 'MIT',
    })
    expect(view.kit?.mcp).toMatchObject({
      npm: '@shopify/dev-mcp',
      license: 'ISC',
      enabled: true,
      downloaded: false,
    })
    expect(view.kit?.cli?.state).toBe('missing')
    expect(view.kit?.cli?.degraded_roles).toEqual(['site.shopify-theme'])
    expect(view.kit?.cli?.spec.login_command).toBe('shopify auth login')
  })

  for (const platform of ['woocommerce', 'magento', 'other', 'none'] as const) {
    it(`${platform} 品牌：kit 为 null，一次本机检测都不跑`, async () => {
      const exec = fakeExec({ cli: '4.8.4', node: 'v22.12.0' })
      const port = makePort({ ws_b: platform }, exec)
      expect(await port.view(actor('ws_b'), {})).toEqual({ platform, kit: null })
      expect(await port.checkCli(actor('ws_b'))).toEqual({ platform, kit: null })
      await port.confirmLogin(actor('ws_b'), { confirmed: true })
      expect(exec.calls).toEqual([])
    })
  }

  it('岗位页只在平台那一行写的岗位上出 CLI 卡（别的岗位页不检测）', async () => {
    const exec = fakeExec({ cli: '4.8.4', node: 'v22.12.0' })
    const port = makePort({ ws_a: 'shopify' }, exec)
    expect(
      (await port.view(actor('ws_a'), { position_id: 'customer-care' })).kit?.cli,
    ).toBeUndefined()
    expect(exec.calls).toEqual([])
    expect((await port.view(actor('ws_a'), { position_id: 'site' })).kit?.cli?.state).toBe(
      'needs_login',
    )
  })

  it('四档：没装 → Node 不够 → 没登录 → 好了；「我登好了」只记时间、可撤回', async () => {
    expect(cliStateOf(undefined, undefined)).toBe('missing')
    const exec = fakeExec({ cli: 'Current Shopify CLI version: 4.8.4', node: 'v20.11.0' })
    const port = makePort({ ws_a: 'shopify' }, exec)
    const old = await port.view(actor('ws_a'), {})
    expect(old.kit?.cli?.state).toBe('node_old')
    expect(old.kit?.cli?.probe).toMatchObject({
      version: '4.8.4',
      node_version: '20.11.0',
      node_ok: false,
    })
    const ok = fakeExec({ cli: '4.8.4', node: 'v22.12.0' })
    const port2 = makePort({ ws_a: 'shopify' }, ok)
    expect((await port2.view(actor('ws_a'), {})).kit?.cli?.state).toBe('needs_login')
    const confirmed = await port2.confirmLogin(actor('ws_a'), { confirmed: true })
    expect(confirmed.kit?.cli).toMatchObject({
      state: 'ready',
      login_confirmed_at: NOW,
      degraded_roles: [],
    })
    expect((await port2.confirmLogin(actor('ws_a'), { confirmed: false })).kit?.cli?.state).toBe(
      'needs_login',
    )
  })

  it('改平台即时生效：Shopify → WooCommerce 卡消失，再改回来卡回来（登录标记还在，本机 CLI 不碰）', async () => {
    const platforms: Record<string, StorefrontPlatform> = { ws_a: 'shopify' }
    const exec = fakeExec({ cli: '4.8.4', node: 'v22.12.0' })
    const port = makePort(platforms, exec)
    await port.confirmLogin(actor('ws_a'), { confirmed: true })
    expect((await port.view(actor('ws_a'), {})).kit?.cli?.state).toBe('ready')
    platforms.ws_a = 'woocommerce'
    expect((await port.view(actor('ws_a'), {})).kit).toBeNull()
    platforms.ws_a = 'shopify'
    expect((await port.view(actor('ws_a'), {})).kit?.cli?.state).toBe('ready')
    // 检测只跑过 `shopify version` 与 `node --version`——没有一条卸载 / 登出
    expect(new Set(exec.calls.map((c) => `${c.bin} ${c.args.join(' ')}`))).toEqual(
      new Set(['shopify version', 'node --version']),
    )
  })

  it('两个品牌互不影响：A 登好了，B 还没；B 是 WooCommerce 时什么都没有', async () => {
    const exec = fakeExec({ cli: '4.8.4', node: 'v22.12.0' })
    const port = makePort({ ws_a: 'shopify', ws_b: 'shopify', ws_c: 'woocommerce' }, exec)
    await port.confirmLogin(actor('ws_a'), { confirmed: true })
    expect((await port.view(actor('ws_a'), {})).kit?.cli?.state).toBe('ready')
    expect((await port.view(actor('ws_b'), {})).kit?.cli?.state).toBe('needs_login')
    expect((await port.view(actor('ws_c'), {})).kit).toBeNull()
  })

  it('检测有缓存；「再查一次」不走缓存', async () => {
    const exec = fakeExec({ node: 'v22.12.0' })
    const port = makePort({ ws_a: 'shopify' }, exec)
    await port.view(actor('ws_a'), {})
    await port.view(actor('ws_a'), {})
    expect(exec.calls.filter((c) => c.bin === 'shopify')).toHaveLength(1)
    await port.checkCli(actor('ws_a'))
    expect(exec.calls.filter((c) => c.bin === 'shopify')).toHaveLength(2)
  })
})

describe('WP216 本机检测：小函数', () => {
  it('只取版本号；Node 主版本比门槛', () => {
    expect(parseVersion('Current Shopify CLI version: 4.8.4\n')).toBe('4.8.4')
    expect(parseVersion('v22.12.0')).toBe('22.12.0')
    expect(parseVersion('nope')).toBeUndefined()
    expect(nodeMajorOk('22.12.0', 22)).toBe(true)
    expect(nodeMajorOk('20.1.0', 22)).toBe(false)
    expect(nodeMajorOk(undefined, 22)).toBe(false)
  })

  it('「我登好了」按品牌落盘，文件里只有 CLI id 与时间', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp216-login-'))
    new PlatformCliLoginStore(dir).set('shopify-cli', NOW)
    expect(new PlatformCliLoginStore(dir).confirmedAt('shopify-cli')).toBe(NOW)
    expect(JSON.parse(readFileSync(join(dir, 'platform-cli.json'), 'utf8'))).toEqual({
      version: 1,
      confirmed: { 'shopify-cli': NOW },
    })
  })

  it('Dev MCP 钉的版本与平台套件那一行写的一致（升级两处一起改）', () => {
    expect(DEV_MCP_ARGS).toContain(`@shopify/dev-mcp@${platformKitOf('shopify')?.mcp?.version}`)
  })
})

describe('WP216 假 CLI 可执行文件（真子进程，PATH 指向替身）', () => {
  const dirs: string[] = []
  afterEach(() => {
    dirs.length = 0
  })

  it('只跑 `shopify version`；子进程环境是白名单 + 关遥测，本进程的秘密一个都不给', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wp216-fakecli-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const log = join(root, 'calls.log')
    writeFileSync(
      join(bin, 'shopify'),
      [
        '#!/bin/sh',
        `echo "args=$* analytics=$SHOPIFY_CLI_NO_ANALYTICS optout=$OPT_OUT_INSTRUMENTATION secret=$AGENTSWS_SECRETS_KEY" >> "${log}"`,
        'echo "Current Shopify CLI version: 4.8.4"',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(join(bin, 'shopify'), 0o755)
    const prober = createPlatformCliProber({
      now: () => NOW,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, AGENTSWS_SECRETS_KEY: 'do-not-leak' },
      exec: defaultProbeExec(),
    })
    const probe = await prober.probe(SHOPIFY_CLI)
    expect(probe.installed).toBe(true)
    expect(probe.version).toBe('4.8.4')
    expect(readFileSync(log, 'utf8').trim()).toBe('args=version analytics=1 optout=true secret=')
  })

  it('PATH 里没有 shopify：installed false，不抛', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'wp216-nocli-'))
    const prober = createPlatformCliProber({
      now: () => NOW,
      env: { PATH: empty },
      exec: defaultProbeExec(),
    })
    const probe = await prober.probe(SHOPIFY_CLI)
    expect(probe.installed).toBe(false)
    expect(probe.node_ok).toBe(false)
  })
})

describe('WP216（Fable 10-05）：平台没设 = 一样都不启用；连了店铺才推断', () => {
  const facts = (profile: StorefrontPlatform | undefined, services: string[]) => {
    const written: StorefrontPlatform[] = []
    return {
      written,
      facts: {
        profile: () => profile,
        connectedServices: () => services,
        writeBack: (_ws: string, p: StorefrontPlatform) => {
          written.push(p)
          return true
        },
      },
    }
  }

  it('没设、也没连 Shopify：undefined，不写回', () => {
    const f = facts(undefined, ['gmail'])
    expect(resolveBrandPlatform(f.facts, 'ws_a')).toBeUndefined()
    expect(f.written).toEqual([])
  })

  it('没设、但连了 Shopify 店铺：推断为 Shopify 并写回档案', () => {
    const f = facts(undefined, ['gmail', 'shopify_admin'])
    expect(resolveBrandPlatform(f.facts, 'ws_a')).toBe('shopify')
    expect(f.written).toEqual(['shopify'])
  })

  it('档案设了就以档案为准（连着 Shopify 也不改）', () => {
    const f = facts('woocommerce', ['shopify_admin'])
    expect(resolveBrandPlatform(f.facts, 'ws_a')).toBe('woocommerce')
    expect(f.written).toEqual([])
  })

  it('没设：岗位页（建站）提示「先选平台」，别的岗位页 / 连接页什么都没有，本机零检测', async () => {
    const exec = fakeExec({ cli: '4.8.4', node: 'v22.12.0' })
    const port = makePort({ ws_u: undefined }, exec)
    const site = await port.view(actor('ws_u'), { position_id: 'site' })
    expect(site.kit).toBeNull()
    expect(site.choose_platform?.choices.map((c) => c.key)).toEqual([
      'shopify',
      'none',
      'woocommerce',
    ])
    expect(await port.view(actor('ws_u'), { position_id: 'customer-care' })).toEqual({ kit: null })
    expect(await port.view(actor('ws_u'), {})).toEqual({ kit: null })
    expect(exec.calls).toEqual([])
  })

  it('在岗位页上选了 Shopify：提示消失、卡出来；选不了的平台 400；档案没建过 409', async () => {
    const exec = fakeExec({ cli: '4.8.4', node: 'v22.12.0' })
    const platforms: Record<string, StorefrontPlatform | undefined> = { ws_u: undefined }
    const port = makePort(platforms, exec)
    const next = await port.setPlatform(actor('ws_u'), {
      storefront_platform: 'shopify',
      position_id: 'site',
    })
    expect(next.choose_platform).toBeUndefined()
    expect(next.kit?.cli?.state).toBe('needs_login')
    await expect(
      port.setPlatform(actor('ws_u'), { storefront_platform: 'woocommerce' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      port.setPlatform(actor('ws_noprofile'), { storefront_platform: 'shopify' }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('Reddit 类品牌（没有建站岗位的职责）：平台是 Shopify 也永远不出 CLI 卡、不检测本机', async () => {
    ROLE_HOLDERS.ws_reddit = ['social.reddit']
    const exec = fakeExec({ cli: '4.8.4', node: 'v22.12.0' })
    const port = makePort({ ws_reddit: 'shopify' }, exec)
    expect((await port.view(actor('ws_reddit'), {})).kit?.cli).toBeUndefined()
    expect((await port.view(actor('ws_reddit'), { position_id: 'site' })).kit?.cli).toBeUndefined()
    expect(exec.calls).toEqual([])
    // 平台也没设的 Reddit 品牌：更是什么都没有
    const port2 = makePort({ ws_reddit: undefined }, exec)
    expect(await port2.view(actor('ws_reddit'), {})).toEqual({ kit: null })
  })
})
