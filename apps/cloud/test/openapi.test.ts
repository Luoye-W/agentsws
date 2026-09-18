/**
 * 签进仓库的 `apps/cloud/openapi.json` 与路由声明是同一份。
 *
 * 顺带钉住两条纪律：文档里不许出现任何 `wst_` 形状的示例，
 * 每条路由都得有 `x-returns`（不写"返回什么"的路由不算写完）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { adminConsoleRoutes } from '../src/index.js'
import { harness } from './helpers.js'

const never = (): never => {
  throw new Error('这里只读声明，不该调到处理器')
}

/**
 * 与 `scripts/gen-cloud-openapi.mjs` **同一套装配**：后台那一组也在 committed
 * 的那份里，所以这边也得挂上，否则两边路径集合永远对不齐。
 */
const consoleRoutes = () =>
  adminConsoleRoutes({
    clock: { now: () => '1970-01-01T00:00:00.000Z' },
    accounts: never,
    admin: never,
    wallet: () => undefined,
    meter: () => undefined,
    baseUrl: 'https://cloud.agentsws.com',
    mail: async () => {},
    bootstrapToken: 'openapi-placeholder-token-not-a-secret',
  })

const HERE = dirname(fileURLToPath(import.meta.url))
const OPENAPI = join(HERE, '../openapi.json')

describe('云侧 OpenAPI', () => {
  it('committed 的那份路径集合与路由声明一致', async () => {
    const h = harness({ modules: [consoleRoutes()] })
    try {
      const committed = JSON.parse(readFileSync(OPENAPI, 'utf8')) as {
        paths: Record<string, Record<string, unknown>>
      }
      const live = h.server.openapi.paths
      expect(Object.keys(committed.paths).sort()).toEqual(Object.keys(live).sort())
    } finally {
      await h.close()
    }
  })

  it('账号与关联那几条都在', async () => {
    const h = harness({ modules: [consoleRoutes()] })
    try {
      for (const p of [
        '/v1/cloud/health',
        '/v1/cloud/auth/magic-link',
        '/v1/cloud/auth/verify',
        '/v1/cloud/me',
        '/v1/cloud/links',
        '/v1/cloud/links/current',
        '/v1/cloud/links/current/revoke',
        '/v1/cloud/links/{id}/renew',
        '/v1/cloud/links/{id}/revoke',
        '/v1/admin/overview',
        '/v1/admin/accounts',
        '/v1/admin/usage',
        '/v1/admin/audit',
      ])
        expect(Object.keys(h.server.openapi.paths)).toContain(p)
    } finally {
      await h.close()
    }
  })

  it('文档里没有任何令牌形状的串', () => {
    const text = readFileSync(OPENAPI, 'utf8')
    expect(text).not.toMatch(/wst_[A-Za-z0-9_-]{10,}/)
    expect(text).not.toMatch(/cs_[A-Za-z0-9_-]{10,}/)
    expect(text).not.toMatch(/cml_[A-Za-z0-9_-]{10,}/)
  })
})
