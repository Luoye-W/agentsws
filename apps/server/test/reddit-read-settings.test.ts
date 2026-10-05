/**
 * WP220（Luoye 10-05）：Reddit 取数路由与浏览器只读限速的设置（真服务进程，不联网）。
 *
 * - `reddit.read` 默认 ①接口中台 → ②浏览器只读；品牌可调顺序、可停用；只认这两级；
 * - 浏览器只读的限速：没改过是保守的默认值；改了存得住、出界的按边界收；不给就不动。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilitySourceSettings } from '@agentsws/contracts'
import { DEFAULT_REDDIT_BROWSER_READ_LIMITS } from '@agentsws/contracts'
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
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp220-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
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

describe('WP220 Reddit 取数路由：reddit.read', () => {
  it('默认 ①接口中台 → ②浏览器只读；调顺序、停一路都存得住；别的级洗掉', async () => {
    const { api, brand } = await boot()
    expect(brand.ownCloud.redditReadRoute()).toEqual({
      order: ['workshop', 'browser_readonly'],
      disabled: [],
    })
    const res = await api('/v1/settings/capability-sources', {
      method: 'PUT',
      body: JSON.stringify({
        capability_sources: {},
        data_source_routing: {
          'reddit.read': {
            order: ['browser_readonly', 'official_key', 'workshop'],
            disabled: ['workshop', 'byo_source'],
          },
        },
      }),
    })
    expect(res.status).toBe(200)
    const body = await data<CapabilitySourceSettings>(res)
    expect(body.data_source_routing?.['reddit.read']).toEqual({
      order: ['browser_readonly', 'workshop'],
      disabled: ['workshop'],
    })
    expect(brand.ownCloud.redditReadRoute()).toEqual({
      order: ['browser_readonly', 'workshop'],
      disabled: ['workshop'],
    })
  })

  it('别的能力不收「浏览器只读」那一级（它只属于 Reddit）', async () => {
    const { api, brand } = await boot()
    await api('/v1/settings/capability-sources', {
      method: 'PUT',
      body: JSON.stringify({
        capability_sources: {},
        data_source_routing: {
          'kol.youtube': { order: ['browser_readonly', 'workshop'], disabled: [] },
          'data.serp.google': { order: ['browser_readonly', 'workshop'], disabled: [] },
        },
      }),
    })
    expect(brand.ownCloud.routeOf('youtube').order).toEqual(['workshop'])
    expect(brand.ownCloud.dataRouteOf('serp.google').order).toEqual(['workshop'])
  })
})

describe('WP220 浏览器只读的限速', () => {
  it('没改过 = 保守的默认值；改了存得住；出界按边界收；下一次不给就不动', async () => {
    const { api, brand } = await boot()
    expect(brand.ownCloud.redditBrowserReadLimits()).toEqual(DEFAULT_REDDIT_BROWSER_READ_LIMITS)
    const res = await api('/v1/settings/capability-sources', {
      method: 'PUT',
      body: JSON.stringify({
        capability_sources: {},
        reddit_browser_read: {
          min_interval_seconds: 2,
          max_pages_per_hour: 60,
          max_pages_per_day: 5000,
        },
      }),
    })
    expect(res.status).toBe(200)
    const want = { min_interval_seconds: 5, max_pages_per_hour: 60, max_pages_per_day: 1000 }
    expect((await data<CapabilitySourceSettings>(res)).reddit_browser_read).toEqual(want)
    await api('/v1/settings/capability-sources', {
      method: 'PUT',
      body: JSON.stringify({ capability_sources: {} }),
    })
    expect(brand.ownCloud.redditBrowserReadLimits()).toEqual(want)
  })
})
