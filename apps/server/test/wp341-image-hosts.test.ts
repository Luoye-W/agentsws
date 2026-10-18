/**
 * WP341 追加（849，Luoye 10-15）：AI 回话里外部图片的域名白名单（品牌级）。
 * 对话里点「以后这个网站的图都直接显示」/ 设置里手动加 → 记进名单；能删；已连店铺的域名（Shopify 店铺地址、
 * 公司 / 官网域名）自动算在里面；重启后名单还在。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenuiImageHostsView, WorkspaceId } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

let server: Server | undefined
const dirs: string[] = []
afterEach(async () => {
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const boot = async (dbDir: string): Promise<Server> => {
  server = await createServer({
    dbDir,
    quiet: true,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
  })
  return server
}

const call = (s: Server, method: string, path: string, body?: unknown) =>
  s.gateway.fetch(
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
const view = async (res: Response): Promise<GenuiImageHostsView> =>
  ((await res.json()) as { data: GenuiImageHostsView }).data

describe('WP341 外部图片白名单', () => {
  it('加（网址也认）/ 删 / 不像域名拒；已连店铺的域名自动算；重启后还在', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'wp341-hosts-'))
    dirs.push(dbDir)
    let s = await boot(dbDir)
    expect(await view(await call(s, 'GET', '/v1/settings/image-hosts'))).toEqual({
      hosts: [],
      shop_hosts: [],
    })
    const added = await view(
      await call(s, 'POST', '/v1/settings/image-hosts', {
        host: 'https://www.Pics.Example.com/a.png',
      }),
    )
    expect(added.hosts.map((h) => h.host)).toEqual(['pics.example.com'])
    expect((await call(s, 'POST', '/v1/settings/image-hosts', { host: '不是域名' })).status).toBe(
      400,
    )
    await call(s, 'POST', '/v1/settings/image-hosts', { host: 'cdn.other.net' })
    const removed = await view(await call(s, 'DELETE', '/v1/settings/image-hosts/cdn.other.net'))
    expect(removed.hosts.map((h) => h.host)).toEqual(['pics.example.com'])

    // 已连店铺：品牌档案里的 Shopify 店铺地址 + 公司 / 官网域名
    await call(s, 'PUT', '/v1/workspace/profile', {
      legal_name: 'Rovella',
      storefront_platform: 'shopify',
      domain: 'shop.rovella.example',
    })
    s.onboarding.setShopifyDomain(
      s.bootstrap.workspace.id as WorkspaceId,
      'rovella-test.myshopify.com',
    )
    const withShop = await view(await call(s, 'GET', '/v1/settings/image-hosts'))
    expect(withShop.shop_hosts).toEqual(
      expect.arrayContaining(['rovella-test.myshopify.com', 'shop.rovella.example']),
    )

    // 对话里的分配是职责那一条（不是负责人）：照样看得到、加得了
    const duty = s.roles.assignments.create({
      person_id: s.bootstrap.person.id,
      workspace_id: s.bootstrap.workspace.id,
      role_id: 'dtc.store',
      granted_by: s.bootstrap.person.id,
      ranges: [{ kind: 'brand', id: s.bootstrap.workspace.id }],
    })
    const asDuty = await s.gateway.fetch(
      new Request('http://127.0.0.1/v1/settings/image-hosts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': duty.id,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ host: 'img.supplier.example' }),
      }),
    )
    expect(asDuty.status).toBe(200)
    await call(s, 'DELETE', '/v1/settings/image-hosts/img.supplier.example')

    // 重启：名单还在（落在数据目录里）
    await s.close()
    server = undefined
    s = await boot(dbDir)
    expect(
      (await view(await call(s, 'GET', '/v1/settings/image-hosts'))).hosts.map((h) => h.host),
    ).toEqual(['pics.example.com'])
  })
})
