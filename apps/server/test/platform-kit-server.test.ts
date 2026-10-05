/**
 * WP216 端到端（真装配线：路由 → 端口 → 品牌档案）：平台改成什么，CLI 卡、技能页、向导清单就跟着变。
 * 本机检测用替身 exec（记录调用），不跑真的 `shopify`、不联网。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { ProbeExec } from '../src/platform-cli.js'

const T0 = '2026-10-05T09:00:00.000Z'
const servers: Server[] = []

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
})
