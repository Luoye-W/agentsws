/**
 * WP202：配对插件时还没有红人职责——本机要能说出来。
 *
 * WP201 真线上跑出来的：插件配上了、采集也「已收进」，可工作台红人页一个人都看不到，
 * 因为这个品牌里没有人持有红人职责（红人库的读要它）。这一组钉住三件事：
 * 1. hello 带 `kol_role_held`（只加），没有时再带「去建岗位」的深链；
 * 2. 工作台「连接 → 浏览器插件」那一节的清单接口带同一格；
 * 3. 有人拿到 `kol.*` 任一条之后，两处都变成 true（算的是这个品牌的活分配）。
 *
 * 另外顺手钉 WP202 第 2 条：职责清单给拆过的「Meta 社媒运营」带 `superseded_by`。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionHello, RoleSummaryView } from '@agentsws/api'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'

let server: Server
let dir: string

const call = (method: string, path: string, body?: unknown): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}
const plugin = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
  server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: EXT_ORIGIN,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )
const data = async <T>(res: Response): Promise<T> => {
  expect(res.status, await res.clone().text()).toBeLessThan(300)
  return ((await res.json()) as { data: T }).data
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp202-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
})

afterAll(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP202 还没有红人职责：hello 与已配清单都说出来', () => {
  it('没人持有 → false + 去建岗位的深链；分给一个人之后 → true、不再给深链', async () => {
    const pairing = await data<{ code: string }>(await call('POST', '/v1/extension/pairings', {}))
    const redeemed = await data<{ token: string }>(
      await server.gateway.fetch(
        new Request('http://127.0.0.1/v1/extension/pair', {
          method: 'POST',
          headers: { Origin: EXT_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ code: pairing.code }),
        }),
      ),
    )

    const before = await data<ExtensionHello>(await plugin('/v1/extension/hello', redeemed.token))
    expect(before.kol_role_held).toBe(false)
    // 装配没绑端口（测试里不 listen）就没有工作台基址，也就不给深链——不瞎拼地址
    if (before.workbench_url === undefined) expect(before.kol_setup_url).toBeUndefined()
    else expect(before.kol_setup_url).toBe(`${before.workbench_url}/org?tab=positions&new=kol`)
    const listed = await data<{ kol_role_held?: boolean }>(
      await call('GET', '/v1/extension/tokens'),
    )
    expect(listed.kol_role_held).toBe(false)

    // 建一个红人岗位、分给所有者自己
    const position = await data<{ id: string }>(
      await call('POST', '/v1/org/positions', {
        name: '红人营销',
        roles: [{ role_id: 'kol.youtube', default: true }],
      }),
    )
    await data(
      await call('POST', '/v1/assignments', {
        person_id: server.bootstrap.ownerAssignment.person_id,
        position_id: position.id,
        ranges: [],
        range_groups: [],
      }),
    )

    const after = await data<ExtensionHello>(await plugin('/v1/extension/hello', redeemed.token))
    expect(after.kol_role_held).toBe(true)
    expect(after.kol_setup_url).toBeUndefined()
    const relisted = await data<{ kol_role_held?: boolean }>(
      await call('GET', '/v1/extension/tokens'),
    )
    expect(relisted.kol_role_held).toBe(true)
  })
})

describe('WP202 职责清单：拆过的老职责带 superseded_by', () => {
  it('「Meta 社媒运营」标着由 FB 主页 + IG 接手；别的职责没有这一格', async () => {
    const roles = await data<RoleSummaryView[]>(await call('GET', '/v1/roles'))
    const meta = roles.find((r) => r.id === 'social.meta')
    expect(meta?.superseded_by).toEqual(['social.facebook', 'social.instagram'])
    expect(roles.find((r) => r.id === 'social.facebook')?.superseded_by).toBeUndefined()
    expect(roles.filter((r) => r.superseded_by !== undefined).map((r) => r.id)).toEqual([
      'social.meta',
    ])
  })
})
