/**
 * WP20：替身也要能走完整条连接向导（表单直填 → 断开），
 * 且与真适配器同一条纪律——**字段值不进替身的任何一处状态**。
 */
import { describe, expect, it } from 'vitest'
import { MockOpenConnector } from '../src/index.js'

const T0 = '2026-09-09T09:00:00.000Z'
const SECRET = 'klaviyo-pk-never-stored-anywhere'

function seeded(seed = 7): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const connect = (): MockOpenConnector =>
  new MockOpenConnector({
    clock: { now: () => T0 },
    random: seeded(),
    workspace_id: 'ws_test',
  })

const INPUT = {
  workspace_id: 'ws_test',
  ownership: 'workspace' as const,
  alias: '主账号',
  fields: { api_key: SECRET, account: 'acme' },
}

describe('MockOpenConnector：表单直填', () => {
  it('连出来的连接在清单里；字段值不进连接对象，也不进 fieldNamesOf', async () => {
    const c = connect()
    const conn = await c.submitForm('klaviyo', INPUT)
    expect(conn.service).toBe('klaviyo')
    expect(conn.alias).toBe('主账号')
    expect(conn.status).toBe('active')
    expect(JSON.stringify(conn)).not.toContain(SECRET)

    const listed = await c.connections('ws_test')
    expect(listed.some((x) => x.id === conn.id)).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(SECRET)

    // 替身只记住字段名
    expect(c.fieldNamesOf(conn.id)).toEqual(['api_key', 'account'])
    expect(JSON.stringify(c.observations.all())).not.toContain(SECRET)
  })

  it('Shopify 走的是自建应用令牌（api_key），不是 OAuth', async () => {
    const c = connect()
    const providers = await c.providers()
    expect(providers.find((p) => p.service === 'shopify_admin')?.auth).toBe('api_key')
    const started = await c.beginConnect('shopify_admin', {
      workspace_id: 'ws_test',
      ownership: 'workspace',
      alias: 'default',
      mode: 'own_app',
    })
    expect(started.secure_form).toBeDefined()
    expect(started.authorization_url).toBeUndefined()
  })

  it('OAuth 类拒绝表单直填；空表单拒；未知 provider 拒', async () => {
    const c = connect()
    await expect(c.submitForm('gmail', INPUT)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(c.submitForm('klaviyo', { ...INPUT, fields: {} })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(c.submitForm('tiktok', INPUT)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('begin → submit 之后那条 request 就结掉了', async () => {
    const c = connect()
    const started = await c.beginConnect('klaviyo', {
      workspace_id: 'ws_test',
      ownership: 'workspace',
      alias: '主账号',
      mode: 'own_app',
    })
    await c.submitForm('klaviyo', { ...INPUT, request_id: started.request_id })
    expect(await c.pollConnect(started.request_id)).toBe('expired')
  })

  it('断开：连接与它记的字段名一起消失；再断一次是 not_found', async () => {
    const c = connect()
    const conn = await c.submitForm('klaviyo', INPUT)
    await c.removeConnection(conn.id)
    expect((await c.connections('ws_test')).some((x) => x.id === conn.id)).toBe(false)
    expect(c.fieldNamesOf(conn.id)).toBeUndefined()
    await expect(c.removeConnection(conn.id)).rejects.toMatchObject({ code: 'not_found' })
  })
})
