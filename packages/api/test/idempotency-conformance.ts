/**
 * 28 §2 幂等表的**契约一致性套件**：接受任意实现，对内存档与 SQLite 档各跑一遍。
 */
import type { Clock } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprint, type SweepableIdempotencyStore } from '../src/idempotency.js'

export interface IdempotencyHarness {
  name: string
  /** 每个用例一份全新实例；`ttlMs` 由用例指定。 */
  make(ttlMs: number): SweepableIdempotencyStore
  dispose?(store: SweepableIdempotencyStore): void
}

export const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse('2026-09-07T09:00:00.000Z')

const record = (over: Partial<Parameters<SweepableIdempotencyStore['put']>[2]> = {}) => ({
  fingerprint: 'fp_a',
  status: 200,
  body: '{"ok":true}',
  content_type: 'application/json',
  stored_at: T0,
  ...over,
})

const clockAt = (ms: number): Clock => ({ now: () => new Date(ms).toISOString() })

export function runIdempotencyConformance(h: IdempotencyHarness): void {
  const live: SweepableIdempotencyStore[] = []
  const make = (ttlMs = DAY): SweepableIdempotencyStore => {
    const s = h.make(ttlMs)
    live.push(s)
    return s
  }
  afterEach(() => {
    for (const s of live.splice(0)) h.dispose?.(s)
  })

  describe(`IdempotencyStore 契约一致性 · ${h.name}`, () => {
    it('没写过的键读出来是 undefined', () => {
      expect(make().get('POST /v1/changes', 'k1', T0)).toBeUndefined()
    })

    it('put / get：24h 内同键重放原响应（状态码、正文、content-type 全原样）', () => {
      const s = make()
      s.put('POST /v1/changes', 'k1', record())
      const got = s.get('POST /v1/changes', 'k1', T0 + 1000)
      expect(got).toEqual(record())
    })

    it('scope 与 key 一起构成主键：同 key 不同路由互不串', () => {
      const s = make()
      s.put('POST /v1/changes', 'k1', record({ body: 'changes' }))
      s.put('POST /v1/approvals', 'k1', record({ body: 'approvals' }))
      expect(s.get('POST /v1/changes', 'k1', T0)?.body).toBe('changes')
      expect(s.get('POST /v1/approvals', 'k1', T0)?.body).toBe('approvals')
      expect(s.size).toBe(2)
    })

    it('同键不同 body：指纹不同 —— 冲突由网关按 fingerprint 判定，表里如实回带原指纹', () => {
      const s = make()
      const first = fingerprint('POST', '/v1/changes', '{"amount":42}')
      const second = fingerprint('POST', '/v1/changes', '{"amount":99}')
      expect(first).not.toBe(second)
      s.put('POST /v1/changes', 'k1', record({ fingerprint: first }))
      expect(s.get('POST /v1/changes', 'k1', T0)?.fingerprint).toBe(first)
      expect(s.get('POST /v1/changes', 'k1', T0)?.fingerprint).not.toBe(second)
    })

    it('同键重写是覆盖，不是新增', () => {
      const s = make()
      s.put('POST /v1/changes', 'k1', record({ status: 200 }))
      s.put('POST /v1/changes', 'k1', record({ status: 201, body: 'later' }))
      expect(s.size).toBe(1)
      expect(s.get('POST /v1/changes', 'k1', T0)?.status).toBe(201)
    })

    it('TTL：到点即当作不存在，并顺手删掉（读路径自清）', () => {
      const s = make()
      s.put('POST /v1/changes', 'k1', record())
      expect(s.get('POST /v1/changes', 'k1', T0 + DAY - 1)).toBeDefined()
      expect(s.get('POST /v1/changes', 'k1', T0 + DAY)).toBeUndefined()
      expect(s.size).toBe(0)
    })

    it('TTL 可调：短 TTL 下更早过期', () => {
      const s = make(1000)
      s.put('POST /v1/changes', 'k1', record())
      expect(s.get('POST /v1/changes', 'k1', T0 + 999)).toBeDefined()
      expect(s.get('POST /v1/changes', 'k1', T0 + 1000)).toBeUndefined()
    })

    it('sweep：按注入的 Clock 批量清过期，未过期的留下，返回删掉的条数', () => {
      const s = make()
      s.put('POST /v1/changes', 'old', record({ stored_at: T0 }))
      s.put('POST /v1/changes', 'new', record({ stored_at: T0 + DAY }))
      expect(s.sweep(clockAt(T0 + DAY))).toBe(1)
      expect(s.size).toBe(1)
      expect(s.get('POST /v1/changes', 'new', T0 + DAY)).toBeDefined()
      // 再扫一次没有可删的
      expect(s.sweep(clockAt(T0 + DAY))).toBe(0)
    })

    it('sweep 空表：不抛，返回 0', () => {
      expect(make().sweep(clockAt(T0))).toBe(0)
    })
  })
}
