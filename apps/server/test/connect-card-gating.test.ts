/**
 * WP111：没有 Docker 时连接卡长什么样。
 *
 * 08 §5 的安装器策略说的是「不许接进一个没加固的 runtime」，不是「没有 runtime
 * 就不许开机」。内测用户的机器上没有 Docker，应用照常起，只是那几张卡置灰、
 * 并说清楚缺的是什么、不装有什么后果。
 */
import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  type CatalogEntry,
  connectCardGating,
  DOCKER_OPTIONAL_REASON,
  needsConnectRuntime,
  RUNTIME_UNHARDENED_REASON,
} from '../src/catalog.js'

const VAULT_REASON = '这台机器没有秘密库密钥（AGENTSWS_SECRETS_KEY），邮箱账号密码无处安全存放'

const gate = (
  entry: Pick<CatalogEntry, 'store' | 'planned'>,
  runtime: 'ready' | 'absent' | 'unhardened' | 'stand_in',
  secretsAvailable = true,
) => connectCardGating({ entry, runtime, secretsAvailable, vaultReason: VAULT_REASON })

describe('needsConnectRuntime', () => {
  it('判据是凭据存哪，不是"是不是云服务"', () => {
    expect(needsConnectRuntime({ store: 'openconnector' } as CatalogEntry)).toBe(true)
    expect(needsConnectRuntime({ store: 'local_vault' } as CatalogEntry)).toBe(false)
  })

  it('目录里两类都有 —— 不是所有卡都要 Docker', () => {
    const needs = CATALOG.filter(needsConnectRuntime)
    const free = CATALOG.filter((e) => !needsConnectRuntime(e))
    expect(needs.length).toBeGreaterThan(0)
    expect(free.length).toBeGreaterThan(0)
    // 邮箱是"没有 Docker 也照常能用"的那条：v1 的楔子是客服，它必须不依赖 runtime
    expect(free.map((e) => e.service)).toContain('imap_smtp')
  })
})

describe('connectCardGating', () => {
  it('没装 Docker：要 runtime 的卡置灰，理由里有「可选」二字', () => {
    const out = gate({ store: 'openconnector' }, 'absent')
    expect(out.available).toBe(false)
    expect(out.requires_runtime).toBe(true)
    expect(out.unavailable_reason).toBe(DOCKER_OPTIONAL_REASON)
    expect(out.unavailable_reason).toContain('可选')
  })

  it('没装 Docker：不经 runtime 的卡**照常能用**（邮箱、模型、Google Alerts 这些）', () => {
    const out = gate({ store: 'local_vault' }, 'absent')
    expect(out).toEqual({ available: true, requires_runtime: false })
  })

  it('装了没加固 ≠ 没装：另一句话，不混成一句', () => {
    const out = gate({ store: 'openconnector' }, 'unhardened')
    expect(out.unavailable_reason).toBe(RUNTIME_UNHARDENED_REASON)
    expect(out.unavailable_reason).not.toBe(DOCKER_OPTIONAL_REASON)
  })

  it('runtime 好了就点得动，但「要 Docker」这个角标不消失', () => {
    expect(gate({ store: 'openconnector' }, 'ready')).toEqual({
      available: true,
      requires_runtime: true,
    })
    expect(gate({ store: 'openconnector' }, 'stand_in')).toEqual({
      available: true,
      requires_runtime: true,
    })
  })

  it('本机库那几张缺密钥 → 说的是密钥的事，不是 Docker 的事', () => {
    const out = gate({ store: 'local_vault' }, 'ready', false)
    expect(out.available).toBe(false)
    expect(out.unavailable_reason).toBe(VAULT_REASON)
    expect(out.requires_runtime).toBe(false)
  })

  it('「我们还没写」压过一切环境问题（用户修不好的那一类排在最前）', () => {
    const out = gate({ store: 'openconnector', planned: '还没接' }, 'absent', false)
    expect(out.unavailable_reason).toBe('还没接')
  })
})
