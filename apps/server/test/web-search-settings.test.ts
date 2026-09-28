/**
 * WP179：网页搜索那一格设置与凭据（真服务进程，不联网）。
 *
 * - 数据接口路由里 `web.search` 这一项：默认第一级就是官方那条（`deepseek_native`），用户能关；
 *   每一项能力只认自己那几级（网页搜索不收红人那三级，红人渠道不收 `deepseek_native`）；
 * - 第二顺位凭据「用户自己的 DeepSeek 官方 key」：只认官方地址那一张卡，代理 / 中转地址的不算；
 *   只看在不在时不读值。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilitySourceSettings } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

let server: Server | undefined
let dir = ''

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

async function boot() {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp179-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
    // 模型测试连接不出网：一律 401（这里只存 key，不测连接）
    modelFetch: async () => new Response('{}', { status: 401 }),
    tokenRefreshIntervalMs: 0,
  })
  const { url } = await server.listen(0)
  const s = server
  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${s.bootstrap.internalToken}`)
    headers.set('X-Assignment', s.bootstrap.ownerAssignment.id)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return fetch(`${url}${path}`, { ...init, headers })
  }
  const brand = await s.brands.forWorkspace(s.brands.bootstrap)
  return { api, brand }
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

describe('WP179 数据接口路由：web.search', () => {
  it('默认第一级就是官方那条、开着；关掉存得住；只认它自己那一级', async () => {
    const { api, brand } = await boot()
    expect(brand.ownCloud.webSearchRoute()).toEqual({ order: ['deepseek_native'], disabled: [] })
    const res = await api('/v1/settings/capability-sources', {
      method: 'PUT',
      body: JSON.stringify({
        capability_sources: {},
        data_source_routing: {
          'web.search': { order: ['deepseek_native', 'workshop'], disabled: ['deepseek_native'] },
          'kol.youtube': { order: ['deepseek_native', 'workshop'], disabled: [] },
        },
      }),
    })
    expect(res.status).toBe(200)
    const view = await data<CapabilitySourceSettings>(res)
    expect(view.data_source_routing?.['web.search']).toEqual({
      order: ['deepseek_native'],
      disabled: ['deepseek_native'],
    })
    // 红人渠道不收 deepseek_native
    expect(view.data_source_routing?.['kol.youtube']).toEqual({ order: ['workshop'], disabled: [] })
    expect(brand.ownCloud.webSearchRoute().disabled).toEqual(['deepseek_native'])
  })
})

describe('WP179 第二顺位凭据：用户自己的 DeepSeek 官方 key', () => {
  it('官方地址那张卡的 key 才算；代理地址的不算；只问在不在时不读值', async () => {
    const { api, brand } = await boot()
    expect(brand.ownModels.hasDeepseekSearchKey()).toBe(false)
    expect(brand.ownModels.deepseekSearchKey()).toBeUndefined()
    const save = (id: string, base_url: string, api_key: string) =>
      api(`/v1/models/providers/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ kind: 'deepseek', base_url, model: 'deepseek-flash', api_key }),
      })
    expect((await save('proxy', 'https://ds-proxy.example.com', 'sk-proxy-test')).status).toBe(200)
    expect(brand.ownModels.hasDeepseekSearchKey()).toBe(false)
    expect((await save('deepseek', 'https://api.deepseek.com', 'sk-official-test')).status).toBe(
      200,
    )
    expect(brand.ownModels.hasDeepseekSearchKey()).toBe(true)
    expect(brand.ownModels.deepseekSearchKey()).toBe('sk-official-test')
  })
})
