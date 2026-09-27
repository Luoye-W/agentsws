/**
 * WP165：托管实例的容器环境变量契约搬进契约包之后，两头（云上写、容器里读）
 * 仍是同一份名字表——写出去的读得回来，缺一样就说缺哪样。
 */
import { describe, expect, it } from 'vitest'
import {
  buildHostedEnv,
  HOSTED_DATA_DIR,
  HOSTED_ENV,
  HOSTED_PORT,
  hostedSnapshotUrl,
  parseHostedEnv,
} from '../src/index.js'

const spec = {
  cloud_base_url: 'https://cloud.example.test/',
  key: 'k'.repeat(64),
  tenants: [{ workspace_id: 'ws_1', cloud_token: 'wst_hosted_x', relay_pairing: 'hrp_y' }],
}

describe('托管实例环境变量契约', () => {
  it('写出去的读得回来；转发器地址是拼出来的，不另传', () => {
    const env = buildHostedEnv(spec)
    expect(env[HOSTED_ENV.dataDir]).toBe(HOSTED_DATA_DIR)
    expect(env[HOSTED_ENV.port]).toBe(String(HOSTED_PORT))
    const parsed = parseHostedEnv(env)
    expect(parsed).toEqual({
      ok: true,
      config: {
        workspace_id: 'ws_1',
        cloud_base_url: 'https://cloud.example.test',
        cloud_token: 'wst_hosted_x',
        relay_pairing: 'hrp_y',
        relay_endpoint: 'https://cloud.example.test/relay/ws_1',
      },
    })
    expect(hostedSnapshotUrl(spec.cloud_base_url)).toBe(
      'https://cloud.example.test/v1/hosted/snapshot',
    )
  })

  it('不是托管实例回 undefined；缺一样就说缺哪样；多于一个租户直接抛', () => {
    expect(parseHostedEnv({})).toBeUndefined()
    expect(parseHostedEnv({ [HOSTED_ENV.flag]: '1', [HOSTED_ENV.workspace]: 'ws_1' })).toEqual({
      ok: false,
      missing: ['cloud_base_url', 'cloud_token', 'relay_pairing'],
    })
    expect(() => buildHostedEnv({ ...spec, tenants: [...spec.tenants, ...spec.tenants] })).toThrow(
      /只托管 1 个/,
    )
  })
})
