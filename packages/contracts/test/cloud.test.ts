/**
 * 49 M1 的三个对象与令牌纪律，在契约这一层就钉住的那几条：
 * 事件名在联合里、动作集只有三个、令牌明文与哈希不在任何 payload 上。
 */
import { describe, expect, it } from 'vitest'
import { CLOUD_BASE_URL_ENV, cloudBaseUrl, DEFAULT_CLOUD_BASE_URL } from '../src/cloud.js'
import type {
  CloudAccount,
  CloudAccountLinkedPayload,
  CloudOrg,
  CloudScope,
  CloudTokenVerifier,
  KnownEventType,
  WorkspaceLink,
} from '../src/index.js'
import {
  CLOUD_SCOPES,
  DEFAULT_CLOUD_SCOPES,
  DEFAULT_WORKSPACE_TOKEN_TTL_MS,
  emailDomain,
  WORKSPACE_TOKEN_PREFIX,
} from '../src/index.js'

describe('49 M1 云账号契约', () => {
  it('两条本地事件在 KnownEventType 里', () => {
    const linked: KnownEventType = 'cloud.account_linked'
    const unlinked: KnownEventType = 'cloud.account_unlinked'
    expect([linked, unlinked]).toEqual(['cloud.account_linked', 'cloud.account_unlinked'])
  })

  it('最小动作集七个（钱包拆 read / topup / admin，WP61 加 data，WP118 加 kol），默认签发不含值守与组织级看账', () => {
    expect(CLOUD_SCOPES).toEqual([
      'ai',
      'wallet:read',
      'wallet:topup',
      'wallet:admin',
      'standby',
      'data',
      'kol',
    ])
    expect(DEFAULT_CLOUD_SCOPES).toEqual(['ai', 'wallet:read', 'wallet:topup', 'data', 'kol'])
    expect(DEFAULT_CLOUD_SCOPES).not.toContain('standby')
    expect(DEFAULT_CLOUD_SCOPES).not.toContain('wallet:admin')
  })

  it('令牌前缀与默认有效期（18 §1 短期）', () => {
    expect(WORKSPACE_TOKEN_PREFIX).toBe('wst_')
    expect(DEFAULT_WORKSPACE_TOKEN_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000)
  })

  it('WorkspaceLink 上只有哈希，没有明文；撤销是一列不是删行', () => {
    const link: WorkspaceLink = {
      id: 'lnk_1',
      workspace_id: 'ws_1',
      cloud_org_id: 'org_1',
      label: '女装品牌',
      token_sha256: 'a'.repeat(64),
      scopes: ['ai'],
      created_at: '2026-09-15T00:00:00.000Z',
      created_by: 'acc_1',
      expires_at: '2026-12-14T00:00:00.000Z',
      revoked_at: '2026-09-16T00:00:00.000Z',
    }
    expect(Object.keys(link)).not.toContain('token')
    expect(link.revoked_at).toBeDefined()
  })

  it('事件 payload 只有邮箱域名与组织 id', () => {
    const payload: CloudAccountLinkedPayload = {
      email_domain: emailDomain('Luoye@Example.COM'),
      cloud_org_id: 'org_1',
      scopes: ['ai', 'wallet:read'],
      expires_at: '2026-12-14T00:00:00.000Z',
    }
    expect(payload.email_domain).toBe('example.com')
    expect(JSON.stringify(payload)).not.toContain('Luoye')
  })

  it('emailDomain 认不出来的一律 unknown，不回原串', () => {
    expect(emailDomain('not-an-email')).toBe('unknown')
    expect(emailDomain('@example.com')).toBe('unknown')
    expect(emailDomain('me@')).toBe('unknown')
  })

  it('CloudTokenVerifier 是一个纯函数：撤销 / 过期 / 不存在都回 undefined', async () => {
    const scopes: CloudScope[] = ['ai']
    const account: CloudAccount = { id: 'acc_1', email: 'me@example.com', created_at: 'now' }
    const org: CloudOrg = {
      id: 'org_1',
      name: 'me@example.com',
      owner_account_id: account.id,
      members: [{ account_id: account.id, role: 'owner', joined_at: 'now' }],
      created_at: 'now',
    }
    const verify: CloudTokenVerifier = async (token) =>
      token === 'wst_good'
        ? { account_id: account.id, org_id: org.id, workspace_id: 'ws_1', scopes }
        : undefined
    expect(await verify('wst_good')).toEqual({
      account_id: 'acc_1',
      org_id: 'org_1',
      workspace_id: 'ws_1',
      scopes: ['ai'],
    })
    expect(await verify('wst_revoked')).toBeUndefined()
  })
})

/** WP110：域名买下来了，默认地址改成 `cloud.agentsws.com`，而且只在这一处定义。 */
describe('WP110 云的默认地址', () => {
  it('默认地址是 cloud.agentsws.com', () => {
    expect(DEFAULT_CLOUD_BASE_URL).toBe('https://cloud.agentsws.com')
    expect(CLOUD_BASE_URL_ENV).toBe('AGENTSWS_CLOUD_BASE_URL')
  })

  it('环境变量永远优先，末尾斜杠去掉；空串当没配', () => {
    expect(cloudBaseUrl({})).toBe(DEFAULT_CLOUD_BASE_URL)
    expect(cloudBaseUrl({ [CLOUD_BASE_URL_ENV]: '   ' })).toBe(DEFAULT_CLOUD_BASE_URL)
    expect(cloudBaseUrl({ [CLOUD_BASE_URL_ENV]: 'http://127.0.0.1:4401/' })).toBe(
      'http://127.0.0.1:4401',
    )
  })
})
