/**
 * WP216 端到端（真装配线：路由 → 端口 → 品牌档案）：平台改成什么，CLI 卡、技能页、向导清单就跟着变。
 * 本机检测用替身 exec（记录调用），不跑真的 `shopify`、不联网。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { ProbeExec } from '../src/platform-cli.js'
import { writeFakeNpm } from './fixtures/fake-cli.js'

const T0 = '2026-10-05T09:00:00.000Z'
const servers: Server[] = []
const tmpDirs: string[] = []

function seeded(seed = 7): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function ticking(): { now: () => string } {
  let t = Date.parse(T0)
  return {
    now: () => {
      t += 1000
      return new Date(t).toISOString()
    },
  }
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function machine() {
  const calls: string[] = []
  const exec: ProbeExec = async (bin, args) => {
    calls.push(`${bin} ${args.join(' ')}`)
    return { ok: true, stdout: bin === 'node' ? 'v22.12.0' : 'Current Shopify CLI version: 4.8.4' }
  }
  const server = await createServer({
    clock: ticking(),
    random: seeded(),
    quiet: true,
    // 局域网发现换成什么都不做的替身（不发包）
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    startRun: false,
    tokenRefreshIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@example.test' },
    platformCliExec: exec,
  })
  servers.push(server)
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers = new Headers({
      Authorization: `Bearer ${server.bootstrap.internalToken}`,
      'X-Assignment': server.bootstrap.ownerAssignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await server.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const parsed = (await res.json()) as { data?: T; error?: unknown }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(parsed)}`)
    return parsed.data as T
  }
  /** 给自己上建站岗位（CLI 卡只给真有那条职责的品牌）。 */
  const takeSite = () => call('POST', '/v1/onboarding/apply', { position_ids: ['site'] })
  const setPlatform = (storefront_platform: string) =>
    call('PUT', '/v1/workspace/profile', { legal_name: '一家耳机店', storefront_platform })
  return { call, setPlatform, takeSite, calls }
}

type KitView = {
  platform: string
  kit: null | { skills: { name: string }[]; cli?: { state: string; spec: { label: string } } }
}
type PlanView = {
  skills: { name: string }[]
  platform_cli?: { label: string; position_id: string }
}
type SkillsView = { name: string }[] | { skills: { name: string }[] }
const skillNames = (v: SkillsView): string[] => (Array.isArray(v) ? v : v.skills).map((s) => s.name)

describe('WP216 按品牌的建站平台走', () => {
  it('Shopify：CLI 卡在、技能页有官方技能、向导最后问「要现在装 CLI 吗」', async () => {
    const m = await machine()
    await m.setPlatform('shopify')
    // 还没人做建站：CLI 卡不出（技能与工具照样按平台启用）
    expect((await m.call<KitView>('GET', '/v1/platform-kit')).kit?.cli).toBeUndefined()
    await m.takeSite()
    const kit = await m.call<KitView>('GET', '/v1/platform-kit?position_id=site')
    expect(kit.kit?.cli?.spec.label).toBe('Shopify CLI')
    expect(kit.kit?.cli?.state).toBe('needs_login')
    expect(skillNames(await m.call<SkillsView>('GET', '/v1/skills'))).toContain('shopify')
    const plan = await m.call<PlanView>('POST', '/v1/onboarding/plan', { position_ids: ['site'] })
    expect(plan.platform_cli).toEqual({
      id: 'shopify-cli',
      label: 'Shopify CLI',
      position_id: 'site',
      tutorial: 'shopify-cli',
    })
    expect(plan.skills.map((s) => s.name)).toContain('shopify')
    // 没勾建站岗位就不问
    const other = await m.call<PlanView>('POST', '/v1/onboarding/plan', {
      position_ids: ['customer-care'],
    })
    expect(other.platform_cli).toBeUndefined()
  })

  it('非 Shopify：卡没有、技能页没有、向导不问、本机一次都没检测', async () => {
    const m = await machine()
    await m.setPlatform('woocommerce')
    await m.takeSite()
    expect(await m.call<KitView>('GET', '/v1/platform-kit?position_id=site')).toEqual({
      platform: 'woocommerce',
      kit: null,
    })
    expect(skillNames(await m.call<SkillsView>('GET', '/v1/skills'))).not.toContain('shopify')
    const plan = await m.call<PlanView>('POST', '/v1/onboarding/plan', { position_ids: ['site'] })
    expect(plan.platform_cli).toBeUndefined()
    expect(plan.skills.map((s) => s.name)).not.toContain('shopify')
    expect(m.calls).toEqual([])
  })

  it('改平台即时切换：Shopify → 还没建站 → Shopify；「我登好了」跟着品牌留着', async () => {
    const m = await machine()
    await m.setPlatform('shopify')
    await m.takeSite()
    const done = await m.call<KitView>('PUT', '/v1/platform-kit/cli/login', { confirmed: true })
    expect(done.kit?.cli?.state).toBe('ready')
    await m.setPlatform('none')
    expect((await m.call<KitView>('GET', '/v1/platform-kit')).kit).toBeNull()
    expect(skillNames(await m.call<SkillsView>('GET', '/v1/skills'))).not.toContain('shopify')
    await m.setPlatform('shopify')
    expect((await m.call<KitView>('GET', '/v1/platform-kit')).kit?.cli?.state).toBe('ready')
    expect(skillNames(await m.call<SkillsView>('GET', '/v1/skills'))).toContain('shopify')
    // 检测只跑过报版本的两条
    expect(new Set(m.calls)).toEqual(new Set(['shopify version', 'node --version']))
  })

  it('没设平台（档案里没写、也没连店铺）：什么都没有；建站岗位页提示先选，负责人选了 Shopify 就启用', async () => {
    const m = await machine()
    await m.call('PUT', '/v1/workspace/profile', { legal_name: '一家还没选平台的店' })
    await m.takeSite()
    expect(skillNames(await m.call<SkillsView>('GET', '/v1/skills'))).not.toContain('shopify')
    expect(await m.call<KitView>('GET', '/v1/platform-kit')).toEqual({ kit: null })
    const ask = await m.call<{ choose_platform?: { choices: { key: string }[] } }>(
      'GET',
      '/v1/platform-kit?position_id=site',
    )
    expect(ask.choose_platform?.choices.map((c) => c.key)).toContain('shopify')
    expect(m.calls).toEqual([])
    const picked = await m.call<KitView>('PUT', '/v1/platform-kit/platform', {
      storefront_platform: 'shopify',
      position_id: 'site',
    })
    expect(picked.kit?.cli?.spec.label).toBe('Shopify CLI')
    expect(skillNames(await m.call<SkillsView>('GET', '/v1/skills'))).toContain('shopify')
  })

  it('跳过了首次设置（品牌档案没建过）：岗位页上选平台用公司名起一份最小档案，不报错', async () => {
    const m = await machine()
    await m.takeSite()
    const ask = await m.call<{ choose_platform?: unknown }>(
      'GET',
      '/v1/platform-kit?position_id=site',
    )
    expect(ask.choose_platform).toBeDefined()
    const picked = await m.call<KitView>('PUT', '/v1/platform-kit/platform', {
      storefront_platform: 'shopify',
      position_id: 'site',
    })
    expect(picked.kit?.cli?.spec.label).toBe('Shopify CLI')
  })
})

describe('WP245 一键安装 / 一键登录（真装配线 + 假 npm / 假 shopify 子进程）', () => {
  type CliView = {
    state: string
    can?: { install: boolean; login: boolean }
    probe?: { installed: boolean; source?: string }
    login_confirmed_at?: string
    job?: { action: string; phase: string; login_url?: string; error?: { code: string } }
  }
  type View = { kit: null | { cli?: CliView } }

  async function wired() {
    const root = mkdtempSync(join(tmpdir(), 'wp245-srv-'))
    tmpDirs.push(root)
    const { npmCli } = writeFakeNpm(root)
    const server = await createServer({
      clock: ticking(),
      random: seeded(),
      quiet: true,
      mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
      startRun: false,
      tokenRefreshIntervalMs: 0,
      // 没有 PATH：系统里的 shopify / node 一个都找不到，只能是工作台自己装的那份
      env: { AGENTSWS_OWNER_EMAIL: 'owner@example.test' },
      platformCliRunner: { toolsDir: join(root, 'tools'), npmCli: async () => npmCli },
    })
    servers.push(server)
    const call = async <T>(method: string, path: string, body?: unknown, token?: string) => {
      const headers = new Headers({
        Authorization: `Bearer ${token ?? server.bootstrap.internalToken}`,
        'X-Assignment': server.bootstrap.ownerAssignment.id,
      })
      if (body !== undefined) headers.set('content-type', 'application/json')
      const res = await server.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      return {
        status: res.status,
        body: (await res.json()) as { data?: T; error?: { code: string } },
      }
    }
    const ok = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const r = await call<T>(method, path, body)
      if (r.status >= 300)
        throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`)
      return r.body.data as T
    }
    await ok('PUT', '/v1/workspace/profile', {
      legal_name: '一家耳机店',
      storefront_platform: 'shopify',
    })
    await ok('POST', '/v1/onboarding/apply', { position_ids: ['site'] })
    const cli = async (): Promise<CliView> =>
      (await ok<View>('GET', '/v1/platform-kit?position_id=site')).kit?.cli as CliView
    const until = async (pred: (c: CliView) => boolean): Promise<CliView> => {
      for (let i = 0; i < 300; i += 1) {
        const c = await cli()
        if (pred(c)) return c
        await new Promise((r) => setTimeout(r, 30))
      }
      throw new Error(`没等到：${JSON.stringify(await cli())}`)
    }
    return { server, call, ok, cli, until }
  }

  it('没装 → 一键装（进数据目录）→ 没登录 → 一键登录（网址给工作台）→ 好了', async () => {
    const m = await wired()
    const first = await m.cli()
    expect(first.state).toBe('missing')
    expect(first.can).toEqual({ install: true, login: true })
    // 没装就点登录：说先装
    expect((await m.call('POST', '/v1/platform-kit/cli/run', { action: 'login' })).status).toBe(409)
    const started = await m.ok<View>('POST', '/v1/platform-kit/cli/run', { action: 'install' })
    expect(started.kit?.cli?.job?.action).toBe('install')
    const installed = await m.until((c) => c.state === 'needs_login')
    expect(installed.probe).toMatchObject({ installed: true, source: 'app' })
    expect(installed.job?.phase).toBe('done')
    await m.ok('POST', '/v1/platform-kit/cli/run', { action: 'login' })
    const waiting = await m.until((c) => c.job?.login_url !== undefined)
    expect(waiting.job?.login_url).toMatch(/^https:\/\/accounts\.shopify\.com\//)
    const ready = await m.until((c) => c.state === 'ready')
    expect(ready.login_confirmed_at).toBeDefined()
    expect(ready.job?.phase).toBe('done')
    // 事件里只有 id / 动作 / 结果，没有输出、没有网址
    const events = m.server.kernel.eventLog
      .readSync({ workspace_id: m.server.bootstrap.workspace.id })
      .filter((e) => e.type.startsWith('platform_cli.'))
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'platform_cli.install_started',
        'platform_cli.install_finished',
        'platform_cli.login_started',
        'platform_cli.login_finished',
      ]),
    )
    expect(JSON.stringify(events)).not.toContain('activate-with-code')
    expect(JSON.stringify(events)).not.toContain('ABCD-EFGH')
  })

  it('只认 install / login / version；AI 运行（runtime 令牌）一律拒', async () => {
    const m = await wired()
    const bad = await m.call('POST', '/v1/platform-kit/cli/run', { action: 'rm -rf /' })
    expect(bad.status).toBe(400)
    const version = await m.ok<View>('POST', '/v1/platform-kit/cli/run', { action: 'version' })
    expect(version.kit?.cli?.state).toBe('missing')
    const { person, workspace } = m.server.bootstrap
    const runtimeToken = m.server.identity.issue('runtime', person.id, workspace.id).token
    const denied = await m.call(
      'POST',
      '/v1/platform-kit/cli/run',
      { action: 'install' },
      runtimeToken,
    )
    expect(denied.status).toBe(403)
    const deniedCancel = await m.call(
      'POST',
      '/v1/platform-kit/cli/cancel',
      undefined,
      runtimeToken,
    )
    expect(deniedCancel.status).toBe(403)
  })
})
