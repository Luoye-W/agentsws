/**
 * WP159：知识库里那张「违规宣称规则」表，走真装配线——真路由 → 真 seo-service → 真知识库（SQLite）。
 *
 * 钉三件事：看得到（按市场分组、每条有出处）；关掉一条 = 知识库里真多一张卡（人激活的）；
 * 再改同一条，旧卡退役不删（留痕）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

let server: Server | undefined
let dir: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

async function boot() {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp159-'))
  let a = 7
  const s = await createServer({
    clock: { now: () => '2026-09-27T09:00:00.000Z' },
    random: () => {
      a = (a * 1664525 + 1013904223) % 4294967296
      return a / 4294967296
    },
    quiet: true,
    startRun: false,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    dbDir: dir,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
  })
  server = s
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': s.bootstrap.ownerAssignment.id,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: res.status, json: (await res.json()) as { data: Record<string, unknown> } }
  }
  return { s, call }
}

type Row = { id: string; market: string; enabled: boolean; origin: string; source_url?: string }

describe('GET / PATCH /v1/knowledge/claim-rules', () => {
  it('按市场分组、有出处；关掉一条写进知识库，再改一次旧卡退役', async () => {
    const { call } = await boot()
    const got = await call('GET', '/v1/knowledge/claim-rules')
    expect(got.status).toBe(200)
    const view = got.json.data as { markets: string[]; markets_from: string; rules: Row[] }
    // 档案里还没写市场 → 按默认国家（美国）
    expect(view.markets_from).toBe('default')
    expect(view.rules.some((r) => r.market === 'eu_uk')).toBe(true)
    expect(view.rules.every((r) => r.source_url?.startsWith('https://'))).toBe(true)

    const off = await call('PATCH', '/v1/knowledge/claim-rules', {
      rule: { id: 'us.made_in_usa', enabled: false },
    })
    expect(off.status).toBe(200)
    const row = (off.json.data.rules as Row[]).find((r) => r.id === 'us.made_in_usa')
    expect(row).toMatchObject({ enabled: false, origin: 'edited' })

    await call('PATCH', '/v1/knowledge/claim-rules', {
      rule: { id: 'us.made_in_usa', enabled: true, reason: '只在美国组装的写 Assembled in USA' },
    })
    const active = await call('GET', '/v1/knowledge/cards?status=active')
    const retired = await call('GET', '/v1/knowledge/cards?status=retired')
    const keyed = (list: unknown) =>
      (list as { subject: { key: string } }[]).filter((c) => c.subject.key === 'us.made_in_usa')
    expect(keyed(active.json.data)).toHaveLength(1)
    expect(keyed(retired.json.data)).toHaveLength(1)

    expect(
      (await call('PATCH', '/v1/knowledge/claim-rules', { rule: { id: 'nope', enabled: false } }))
        .status,
    ).toBe(400)
    expect((await call('PATCH', '/v1/knowledge/claim-rules', {})).status).toBe(400)
  })

  it('品牌档案写了目标市场（德国、英国）：开欧盟 / 英国组，美国组不开；改公司档案不给市场就沿用', async () => {
    const { s, call } = await boot()
    const actor = {
      workspace_id: s.bootstrap.workspace.id,
      person_id: s.bootstrap.person.id,
      assignment_id: '',
      role_id: '',
    }
    await s.onboarding.port.setProfile(actor, {
      legal_name: 'NordVolt GmbH',
      markets: ['de', 'gb', 'xx1'],
    })
    expect(s.onboarding.brandProfile(actor.workspace_id).markets).toEqual(['DE', 'GB'])
    await s.onboarding.port.setProfile(actor, { legal_name: 'NordVolt GmbH' })
    expect(s.onboarding.brandProfile(actor.workspace_id).markets).toEqual(['DE', 'GB'])
    const view = (await call('GET', '/v1/knowledge/claim-rules')).json.data as {
      markets: string[]
      markets_from: string
      groups: { id: string; enabled: boolean }[]
    }
    expect(view).toMatchObject({ markets: ['DE', 'GB'], markets_from: 'brand_profile' })
    expect(view.groups.filter((g) => g.enabled).map((g) => g.id)).toEqual(['global', 'eu_uk'])
  })
})
