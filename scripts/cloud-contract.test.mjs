/**
 * WP164：云端对外契约生成器的用例。不出网、不起服务——只读契约源码。
 *
 * 真响应对不对得上契约，在云端那一侧核（`apps/cloud-worker/test/wp164-contract.test.ts`）；
 * 这里钉生成器自己：签进仓库的那份与类型零漂移、运营后台不进来、每条路由都说清了
 * 成功回什么、错误长什么样。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildCloudContract, CLOUD_CONTRACT_OUT } from './cloud-contract-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const doc = buildCloudContract(ROOT, '0.0.0')
const committed = JSON.parse(readFileSync(join(ROOT, CLOUD_CONTRACT_OUT), 'utf8'))
const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ path, method, op })),
)

describe('云端对外契约（生成器）', () => {
  it('签进仓库的那份与类型生成的结果一致（路径、方法、schema 都算）', () => {
    expect(committed.paths).toEqual(doc.paths)
    expect(committed.components).toEqual(doc.components)
  })

  it('运营后台与 Stripe 回调不进对外契约', () => {
    const paths = Object.keys(doc.paths)
    expect(paths.filter((p) => p.startsWith('/v1/admin'))).toEqual([])
    expect(paths).not.toContain('/v1/wallet/topup/stripe/webhook')
  })

  it('每条路由：有一个成功状态、有 tag、带凭据的都有 security；引用的 schema 都存在', () => {
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/[A-Za-z0-9_]+/g) ?? []
    for (const ref of refs) {
      const name = ref.replace('#/components/schemas/', '')
      expect(doc.components.schemas[name], ref).toBeDefined()
    }
    for (const { path, method, op } of operations) {
      const where = `${method.toUpperCase()} ${path}`
      const statuses = Object.keys(op.responses).map(Number)
      expect(
        statuses.some((s) => (s >= 200 && s < 300) || s === 101),
        where,
      ).toBe(true)
      expect(op.tags.length, where).toBe(1)
      expect(Array.isArray(op.security), where).toBe(true)
      // 路径里的每个 {参数} 都声明了
      for (const m of path.matchAll(/\{(\w+)\}/g)) {
        expect(
          (op.parameters ?? []).some((p) => p.in === 'path' && p.name === m[1]),
          `${where} 缺路径参数 ${m[1]}`,
        ).toBe(true)
      }
    }
  })

  it('我们加的头与错误形状写清楚了：AI 口的 402 / 422 与数据驻留头', () => {
    const chat = doc.paths['/v1/ai/chat/completions'].post
    expect(chat.responses['402']['x-error-codes']).toEqual(['insufficient_credits'])
    expect(chat.responses['422']['x-error-codes']).toEqual(['residency_blocked'])
    expect(chat.parameters.map((p) => p.name)).toContain('X-Agentsws-Region')
    expect(chat.responses['200'].content['text/event-stream']['x-sse-data']).toBeDefined()
    const connect = doc.paths['/relay/{workspace}/connect'].get
    expect(connect['x-websocket'].client.$ref).toBe('#/components/schemas/RelayClientFrame')
  })
})
