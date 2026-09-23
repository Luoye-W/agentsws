/**
 * WP128：托管实例的纯逻辑（生命周期、环境变量契约、令牌、费用估算）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildHostedEnv,
  CONTAINERS_PRICING,
  composeHostedToken,
  deriveHostedKey,
  desiredFor,
  estimateCost,
  fullMonthCost,
  HOSTED_KEEPALIVE_MS,
  isInstanceType,
  parseHostedEnv,
  restartBackoffMs,
  secondsInMonth,
  snapshotKeptUntil,
  stateOf,
  stopReasonFor,
  workspaceOfHostedToken,
} from '../src/index.js'

describe('生命周期：订阅状态 → 容器该不该跑', () => {
  it('active / cancelling / grace 跑；suspended / none 停', () => {
    expect(desiredFor('active')).toBe('run')
    expect(desiredFor('cancelling')).toBe('run')
    expect(desiredFor('grace')).toBe('run')
    expect(desiredFor('suspended')).toBe('stop')
    expect(desiredFor('none')).toBe('stop')
    expect(stopReasonFor('suspended')).toBe('suspended')
    expect(stopReasonFor('none')).toBe('cancelled')
  })

  it('状态四档：停 / 睡 / 刚起 / 在跑', () => {
    const now = '2026-09-23T10:00:00.000Z'
    expect(stateOf({ desired: 'stop', running: true, now })).toBe('stopped')
    expect(stateOf({ desired: 'run', running: false, now })).toBe('sleeping')
    expect(
      stateOf({ desired: 'run', running: true, now, started_at: '2026-09-23T09:59:00.000Z' }),
    ).toBe('starting')
    expect(
      stateOf({
        desired: 'run',
        running: true,
        now,
        started_at: '2026-09-23T09:00:00.000Z',
        last_heartbeat_at: '2026-09-23T09:58:00.000Z',
      }),
    ).toBe('running')
    // 心跳超过两拍没来：不说「在跑」
    const stale = new Date(Date.parse(now) - HOSTED_KEEPALIVE_MS * 3).toISOString()
    expect(stateOf({ desired: 'run', running: true, now, last_heartbeat_at: stale })).toBe(
      'starting',
    )
  })

  it('重起退避封顶最后一档；快照留 30 天', () => {
    expect(restartBackoffMs(0)).toBe(0)
    expect(restartBackoffMs(99)).toBe(600_000)
    expect(snapshotKeptUntil('2026-09-01T00:00:00.000Z')).toBe('2026-10-01T00:00:00.000Z')
  })
})

describe('容器环境变量：写出去的读得回来', () => {
  it('build → parse 往返', () => {
    const key = deriveHostedKey('seed', 'ws_a')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(deriveHostedKey('seed', 'ws_a')).toBe(key)
    expect(deriveHostedKey('seed', 'ws_b')).not.toBe(key)
    const env = buildHostedEnv({
      cloud_base_url: 'https://cloud.example.test/',
      key,
      tenants: [{ workspace_id: 'ws_a', cloud_token: 'wst_hosted_x.y', relay_pairing: 'hrp_1' }],
    })
    expect(env.AGENTSWS_BIND_HOST).toBe('0.0.0.0')
    // 工作区号在启动参数里只出现一处（共享容器的口子）
    expect(Object.values(env).filter((v) => v.includes('ws_a'))).toEqual(['ws_a'])
    expect(env.AGENTSWS_SECRETS_KEY).toBe(key)
    const parsed = parseHostedEnv(env)
    expect(parsed).toEqual({
      ok: true,
      config: {
        workspace_id: 'ws_a',
        cloud_base_url: 'https://cloud.example.test',
        cloud_token: 'wst_hosted_x.y',
        relay_endpoint: 'https://cloud.example.test/relay/ws_a',
        relay_pairing: 'hrp_1',
      },
    })
  })

  it('本轮一个容器一个工作区：多塞一个直接抛', () => {
    const tenant = { workspace_id: 'ws_a', cloud_token: 't', relay_pairing: 'p' }
    expect(() =>
      buildHostedEnv({ cloud_base_url: 'https://c', key: 'k', tenants: [tenant, tenant] }),
    ).toThrow(/只托管 1 个/)
    expect(() => buildHostedEnv({ cloud_base_url: 'https://c', key: 'k', tenants: [] })).toThrow()
  })

  it('没开托管 = undefined；开了缺字段 = 说缺哪样', () => {
    expect(parseHostedEnv({})).toBeUndefined()
    const partial = parseHostedEnv({ AGENTSWS_HOSTED: '1', AGENTSWS_WORKSPACE_ID: 'ws_a' })
    expect(partial).toMatchObject({ ok: false })
    expect(partial !== undefined && !partial.ok ? partial.missing : []).toContain('cloud_token')
  })
})

describe('托管令牌', () => {
  it('令牌里读得出工作区号；形状不对一律 undefined', () => {
    const token = composeHostedToken('ws_a:b.c', 'r4nd0m')
    expect(token.startsWith('wst_hosted_')).toBe(true)
    expect(workspaceOfHostedToken(token)).toBe('ws_a:b.c')
    expect(workspaceOfHostedToken('wst_abc')).toBeUndefined()
    expect(workspaceOfHostedToken('wst_hosted_')).toBeUndefined()
    expect(workspaceOfHostedToken('wst_hosted_abc.')).toBeUndefined()
    expect(
      workspaceOfHostedToken(`wst_hosted_${Buffer.from('../x').toString('base64url')}.r`),
    ).toBe(undefined)
  })
})

describe('费用估算（按官方单价）', () => {
  it('单价与规格照官网抄', () => {
    expect(CONTAINERS_PRICING.rates_usd.memory_per_gib_second).toBe(0.0000025)
    expect(CONTAINERS_PRICING.rates_usd.vcpu_per_second).toBe(0.00002)
    expect(CONTAINERS_PRICING.rates_usd.disk_per_gb_second).toBe(0.00000007)
    expect(CONTAINERS_PRICING.instance_types.basic).toEqual({
      vcpu: 0.25,
      memory_gib: 1,
      disk_gb: 4,
    })
    expect(isInstanceType('basic')).toBe(true)
    expect(isInstanceType('huge')).toBe(false)
  })

  it('一个 basic 常驻 30 天：内存 6.48 + 磁盘 0.7258 + CPU（10% 忙）1.296', () => {
    expect(secondsInMonth('2026-09')).toBe(30 * 86_400)
    expect(secondsInMonth('2026-02')).toBe(28 * 86_400)
    const cost = fullMonthCost('basic', '2026-09')
    expect(cost.memory_usd).toBeCloseTo(6.48, 4)
    expect(cost.disk_usd).toBeCloseTo(0.7258, 4)
    expect(cost.cpu_usd).toBeCloseTo(1.296, 4)
    expect(cost.total_usd).toBeCloseTo(8.5018, 3)
  })

  it('lite 常驻 30 天约 2.31 美元；秒数为 0 就是 0', () => {
    expect(fullMonthCost('lite', '2026-09').total_usd).toBeCloseTo(2.3069, 3)
    expect(estimateCost({ instance_type: 'basic', seconds: 0 }).total_usd).toBe(0)
  })
})
