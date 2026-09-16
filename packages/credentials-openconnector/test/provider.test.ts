/**
 * WP86（55 §4 凭据段）：`credentials-openconnector` 的边界。
 *
 * 四条硬的：
 * 1. 官方 seam 是**单 provider**（这条是 55 §4 留的"未验证"，用例把结论钉下来）；
 * 2. `readRecord` / `describe` **一个 refresh token 都不出 OpenConnector**；
 * 3. **跨工作区读不到**；
 * 4. `modifyRecord` 只能触发"让 OpenConnector 刷新"，写不进新钥匙。
 */
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import type { OpenConnectorGrant, OpenConnectorSource } from '../src/index.js'
import {
  CompositeCredentials,
  CredentialsBoundaryError,
  connectionCredentialKey,
  envRefSource,
} from '../src/index.js'

/**
 * 假的 OpenConnector：**refresh token 只存在于这个对象的闭包里**，
 * 一个字节都不进它交出去的 grant。用例最后会逐条查这一点。
 */
function fakeConnector(workspace_id = 'ws_alpha'): OpenConnectorSource & { refreshes: number } {
  const REFRESH_TOKEN = 'rt_never_leaves_openconnector'
  let serial = 0
  const state = new Map<string, OpenConnectorGrant>([
    ['shopify', { access: 'oct_shopify_1', expires_at: '2026-09-16T10:00:00.000Z' }],
    ['email', { access: 'oct_email_1' }],
  ])
  const api = {
    refreshes: 0,
    workspace_id: workspace_id as OpenConnectorSource['workspace_id'],
    async kinds() {
      return [...state.keys()].sort()
    },
    async grant(kind: string) {
      return state.get(kind)
    },
    async refresh(kind: string) {
      if (!state.has(kind)) return undefined
      api.refreshes += 1
      serial += 1
      // 真实实现里这一步是 OpenConnector 拿 REFRESH_TOKEN 去换新的 access；
      // 我们这一侧看得见的只有换回来的结果。
      const next = { access: `oct_${kind}_${serial + 1}_from_${REFRESH_TOKEN.length}` }
      state.set(kind, next)
      return next
    },
  }
  return api
}

async function providerOn(config: {
  refs?: ReturnType<typeof envRefSource>
  connector?: OpenConnectorSource
}): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(CompositeCredentials, {
    refs: config.refs ?? envRefSource(),
    ...(config.connector === undefined ? {} : { connector: config.connector }),
  })
  return { ctx, dispose: async () => void (await ctx.fiber.dispose()) }
}

describe('官方 ctx.credentials 是单 provider（55 §4 的"未验证"，实测结论）', () => {
  it('一棵树上挂第二个 CredentialProvider 直接抛，第一个继续有效', async () => {
    const { ctx, dispose } = await providerOn({ refs: envRefSource({ A_KEY: 'first' }) })
    let thrown: string | undefined
    try {
      await ctx.plugin(CompositeCredentials, { refs: envRefSource({ A_KEY: 'second' }) })
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e)
    }
    expect(thrown).toContain('credentials')
    expect(thrown).toContain('registered')
    // 先挂的那个照旧答话——所以"分层"只能在一个 provider 内部做
    expect((await ctx.credentials.resolve(credentialRef('A_KEY')))?.value).toBe('first')
    await dispose()
  })
})

describe('引用半边走本机（模型 key 那些）', () => {
  it('resolve 回值、describe 不回值', async () => {
    const { ctx, dispose } = await providerOn({ refs: envRefSource({ MODEL_KEY: 'sk-abc' }) })
    expect((await ctx.credentials.resolve(credentialRef('MODEL_KEY')))?.value).toBe('sk-abc')
    const info = await ctx.credentials.describe(credentialRef('MODEL_KEY'))
    expect(info.configured).toBe(true)
    expect(JSON.stringify(info)).not.toContain('sk-abc')
    await dispose()
  })

  it('空值等于没有（官方 seam 的规矩）', async () => {
    const { ctx, dispose } = await providerOn({ refs: envRefSource({ EMPTY_KEY: '' }) })
    expect(await ctx.credentials.resolve(credentialRef('EMPTY_KEY'))).toBeUndefined()
    expect((await ctx.credentials.describe(credentialRef('EMPTY_KEY'))).configured).toBe(false)
    await dispose()
  })
})

describe('记录半边走 OpenConnector', () => {
  it('readRecord 只有 { kind, access, expires } —— refresh token 一个字节都没有', async () => {
    const connector = fakeConnector()
    const { ctx, dispose } = await providerOn({ connector })
    const key = connectionCredentialKey('ws_alpha', 'shopify')
    const record = await ctx.credentials.readRecord(key)
    expect(record?.kind).toBe('grant')
    const payload = (record as { payload: Record<string, unknown> }).payload
    expect(Object.keys(payload).sort()).toEqual(['access', 'expires', 'kind'])
    expect(JSON.stringify(record)).not.toContain('rt_never_leaves_openconnector')
    expect(JSON.stringify(record)).not.toContain('refresh')
    await dispose()
  })

  it('describeRecord 不含值；listRecords 只列这一个工作区', async () => {
    const connector = fakeConnector()
    const { ctx, dispose } = await providerOn({ connector })
    const info = await ctx.credentials.describeRecord(connectionCredentialKey('ws_alpha', 'email'))
    expect(info).toEqual({ configured: true, kind: 'grant', writable: true })
    expect(JSON.stringify(info)).not.toContain('oct_')

    const listed = await ctx.credentials.listRecords()
    expect(listed.map((r) => String(r.key))).toEqual(['ws-alpha/email', 'ws-alpha/shopify'])
    expect(JSON.stringify(listed)).not.toContain('oct_')
    await dispose()
  })

  it('跨工作区读不到：别人家的 owner 段一律当"没有这条记录"', async () => {
    const { ctx, dispose } = await providerOn({ connector: fakeConnector('ws_alpha') })
    const theirs = credentialKey('ws-beta', 'shopify')
    expect(await ctx.credentials.readRecord(theirs)).toBeUndefined()
    expect(await ctx.credentials.describeRecord(theirs)).toEqual({
      configured: false,
      writable: false,
    })
    await dispose()
  })

  it('没连过的 kind：读不到（不是报错——报错会泄漏"那边有没有这条连接"）', async () => {
    const { ctx, dispose } = await providerOn({ connector: fakeConnector() })
    expect(
      await ctx.credentials.readRecord(connectionCredentialKey('ws_alpha', 'youtube_data')),
    ).toBeUndefined()
    await dispose()
  })
})

describe('modifyRecord：唯一的写就是"让 OpenConnector 刷新"', () => {
  it('mutate 回 undefined → 什么都不做（官方语义）', async () => {
    const connector = fakeConnector()
    const { ctx, dispose } = await providerOn({ connector })
    const key = connectionCredentialKey('ws_alpha', 'shopify')
    const out = await ctx.credentials.modifyRecord(key, async () => undefined)
    expect((out as { payload: { access: string } }).payload.access).toBe('oct_shopify_1')
    expect(connector.refreshes).toBe(0)
    await dispose()
  })

  it('mutate 回一条 grant → 触发刷新，但**回来的是 OpenConnector 给的那一把**', async () => {
    const connector = fakeConnector()
    const { ctx, dispose } = await providerOn({ connector })
    const key = connectionCredentialKey('ws_alpha', 'shopify')
    const out = await ctx.credentials.modifyRecord(key, async () => ({
      kind: 'grant',
      // 调用方想塞一把自己的 token 进去——这一把必须被丢掉
      payload: { kind: 'shopify', access: 'oct_forged_by_caller' },
    }))
    expect(connector.refreshes).toBe(1)
    const access = (out as { payload: { access: string } }).payload.access
    expect(access).not.toBe('oct_forged_by_caller')
    expect(access.startsWith('oct_shopify_')).toBe(true)
    await dispose()
  })

  it('想存一把 api-key → 拒（外部连接的凭据不在 dsh 这一侧）', async () => {
    const { ctx, dispose } = await providerOn({ connector: fakeConnector() })
    await expect(
      ctx.credentials.modifyRecord(connectionCredentialKey('ws_alpha', 'shopify'), async () => ({
        kind: 'api-key',
        key: 'sk-someone-typed-this',
      })),
    ).rejects.toBeInstanceOf(CredentialsBoundaryError)
    await dispose()
  })

  it('跨工作区写 → 拒', async () => {
    const { ctx, dispose } = await providerOn({ connector: fakeConnector('ws_alpha') })
    await expect(
      ctx.credentials.modifyRecord(credentialKey('ws-beta', 'shopify'), async () => ({
        kind: 'grant',
        payload: {},
      })),
    ).rejects.toBeInstanceOf(CredentialsBoundaryError)
    await dispose()
  })

  it('deleteRecord：没有的是 no-op，有的一律拒（断开连接走连接页）', async () => {
    const { ctx, dispose } = await providerOn({ connector: fakeConnector() })
    await expect(
      ctx.credentials.deleteRecord(connectionCredentialKey('ws_alpha', 'nope')),
    ).resolves.toBeUndefined()
    await expect(
      ctx.credentials.deleteRecord(connectionCredentialKey('ws_alpha', 'shopify')),
    ).rejects.toBeInstanceOf(CredentialsBoundaryError)
    await dispose()
  })
})
