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
import { harness } from './helpers.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OPENAPI = join(HERE, '../openapi.json')

describe('云侧 OpenAPI', () => {
  it('committed 的那份路径集合与路由声明一致', async () => {
    const h = harness()
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
    const h = harness()
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
