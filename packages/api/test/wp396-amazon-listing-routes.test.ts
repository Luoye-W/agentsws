/**
 * WP396（docs/106 §13）：Listing 体检在网关这一层的形状——按品牌（principal 的 workspace）走端口；
 * 改规则的请求体逐格验（核对日期要 YYYY-MM-DD、多余的格子不收）；没装配回 not_implemented。
 */
import { describe, expect, it } from 'vitest'
import type { AmazonListingPort } from '../src/index.js'
import { createGateway } from '../src/index.js'
import { harness } from './helpers.js'

async function wired(withPort = true) {
  const h = await harness()
  const calls: string[] = []
  const port: AmazonListingPort = {
    view: (ws) => {
      calls.push(`view:${ws}`)
      return {
        own_asins: 2,
        rules: [],
        reader_ready: true,
        footer: { zh: '连上 Amazon 店铺后能查到更多', en: 'x' },
      }
    },
    run: async (ws) => {
      calls.push(`run:${ws}`)
      return { needs_setup: 'amazon.own_asins' }
    },
    setRule: (_ws, patch) => {
      calls.push(`rule:${JSON.stringify(patch)}`)
      return { ok: true }
    },
  }
  // 亚马逊店铺运营读得到商品（product read）；测试的通用岗位没有，这里补上
  const roles = {
    ...h.deps.roles,
    can: (id: string, domain: string, op: string, r: never) =>
      domain === 'product'
        ? id === h.assignment.id
        : h.deps.roles.can(id, domain as never, op as never, r),
  }
  const gateway = createGateway({
    ...h.deps,
    roles: roles as never,
    ...(withPort ? { amazonListing: port } : {}),
  })
  const owner = (method: string, path: string, body?: unknown) =>
    gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${h.token}`,
          'X-Assignment': h.assignment.id,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { h, calls, owner }
}

describe('WP396 · /v1/amazon-listing*', () => {
  it('看面板、现在体检、改规则：按品牌走端口', async () => {
    const { h, calls, owner } = await wired()
    const view = await owner('GET', '/v1/amazon-listing')
    expect(view.status).toBe(200)
    expect(((await view.json()) as { data: { own_asins: number } }).data.own_asins).toBe(2)
    const run = await owner('POST', '/v1/amazon-listing/run')
    expect(((await run.json()) as { data: { needs_setup: string } }).data.needs_setup).toBe(
      'amazon.own_asins',
    )
    const rule = await owner('PUT', '/v1/amazon-listing/rules', {
      rule_id: 'title.max_chars',
      params: { max_chars: 150 },
      checked_at: '2026-10-18',
    })
    expect(rule.status).toBe(200)
    expect(calls).toEqual([
      `view:${h.workspace_id}`,
      `run:${h.workspace_id}`,
      'rule:{"rule_id":"title.max_chars","params":{"max_chars":150},"checked_at":"2026-10-18"}',
    ])
  })

  it('核对日期写错、多余的格子：400', async () => {
    const { owner } = await wired()
    expect((await owner('PUT', '/v1/amazon-listing/rules', { checked_at: '10/18' })).status).toBe(
      400,
    )
    expect((await owner('PUT', '/v1/amazon-listing/rules', { nope: 1 })).status).toBe(400)
  })

  it('没装配：not_implemented', async () => {
    const { owner } = await wired(false)
    expect((await owner('GET', '/v1/amazon-listing')).status).toBe(501)
  })
})
