/**
 * WP418（自查 C1 / C4 / A1 / B11）：Shopify 四种授权统一认。
 *
 * - 岗位页做过 CLI 店铺授权 = 店铺后台已连（同步判断读那份授权记录；过期 / 被收回不算）；
 * - 平台没设时「先选建站平台」按**职责**判，不按岗位 id（用户自己建的岗位 id 是 `pos-xxxx`）；
 * - 只做了 CLI 店铺授权的用户也查得到单（云端、连接器都没有时才用它）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionMeta, RunRequest, WorkspaceId } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectLike } from '../src/connections.js'
import { createPlatformCliProber, PlatformCliLoginStore } from '../src/platform-cli.js'
import { createPlatformKitPort } from '../src/platform-kit.js'
import { createConnectRecordSource } from '../src/records.js'
import { hasLiveStoreGrant } from '../src/shop-auth.js'

const NOW = '2026-10-19T08:00:00.000Z'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp418-connect-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('CLI 店铺授权算「店铺后台已连」（自查 C1）', () => {
  const write = (body: unknown): string => {
    const f = join(dir, 'shop-admin.json')
    writeFileSync(f, JSON.stringify(body))
    return f
  }
  const grant = (expires_at: string) => ({
    store: 'rovella.myshopify.com',
    scopes: ['write_products'],
    acquired_at: '2026-10-19T00:00:00.000Z',
    expires_at,
    refreshable: false,
  })

  it('没过期的授权算；过期 / 被收回 / 没有文件都不算', () => {
    expect(hasLiveStoreGrant(undefined, NOW)).toBe(false)
    expect(hasLiveStoreGrant(join(dir, 'nope.json'), NOW)).toBe(false)
    const live = write({
      version: 1,
      grants: { 'rovella.myshopify.com': grant('2026-10-20T00:00:00.000Z') },
    })
    expect(hasLiveStoreGrant(live, NOW)).toBe(true)
    const old = write({
      version: 1,
      grants: { 'rovella.myshopify.com': grant('2026-10-19T08:02:00.000Z') },
    })
    // 到期前留了余量：几分钟内要过期的按过期算
    expect(hasLiveStoreGrant(old, NOW)).toBe(false)
    const revoked = write({
      version: 1,
      grants: { 'rovella.myshopify.com': grant('2026-10-20T00:00:00.000Z') },
      problem: { store: 'rovella.myshopify.com', code: 'revoked', at: '2026-10-19T07:00:00.000Z' },
    })
    expect(hasLiveStoreGrant(revoked, NOW)).toBe(false)
    // 只是缺一项权限：店还是连着的
    const partial = write({
      version: 1,
      grants: { 'rovella.myshopify.com': grant('2026-10-20T00:00:00.000Z') },
      problem: {
        store: 'rovella.myshopify.com',
        code: 'missing_scope',
        at: '2026-10-19T07:00:00.000Z',
      },
    })
    expect(hasLiveStoreGrant(partial, NOW)).toBe(true)
  })
})

describe('平台没设时「先选建站平台」按职责判（自查 A1）', () => {
  it('用户自己建的岗位（pos-xxxx）担着建站职责也出；没担的不出', async () => {
    const port = createPlatformKitPort({
      now: () => NOW,
      platformOf: () => undefined,
      setPlatform: () => true,
      hasRoles: () => true,
      platformChoices: () => [{ key: 'shopify', label: 'Shopify', supported: true }],
      prober: createPlatformCliProber({
        now: () => NOW,
        env: {},
        exec: async () => ({ ok: false, stdout: '', missing: true }),
      }),
      loginStoreOf: () => new PlatformCliLoginStore(undefined),
      positionNeedsPlatform: (_ws, position_id) => position_id === 'pos-k3x9',
    })
    const actor = { workspace_id: 'ws_a', person_id: 'p', assignment_id: 'asg' } as never
    const mine = await port.view(actor, { position_id: 'pos-k3x9' })
    expect(mine.choose_platform?.choices.map((c) => c.key)).toEqual(['shopify'])
    expect(await port.view(actor, { position_id: 'pos-kefu' })).toEqual({ kit: null })
    // 老的岗位模板 id 照旧认
    expect((await port.view(actor, { position_id: 'site' })).choose_platform).toBeDefined()
  })
})

describe('只做了 CLI 店铺授权也查得到单（自查 B11）', () => {
  const notUsed = (): never => {
    throw new Error('connector not used')
  }
  const make = (opts: { connector?: boolean; cli?: boolean }) => {
    const executed: string[] = []
    const sent: string[] = []
    const connect = {
      providers: notUsed,
      connections: notUsed,
      beginConnect: notUsed,
      pollConnect: notUsed,
      submitForm: notUsed,
      removeConnection: notUsed,
      actions: async (service: string): Promise<ActionMeta[]> =>
        ['shopify_admin.list_products'].map((id) => ({
          id,
          service,
          input_schema: {},
          side_effect: 'read' as const,
        })),
      issueToken: async (input: { kind: string; assignment_id: string }) => ({
        token: 'tok',
        kind: input.kind,
        assignment_id: input.assignment_id,
        expires_at: NOW,
        allowed_actions: [],
        allowed_connections: [],
        allowed_proxies: [],
      }),
      revokeTokens: async () => {},
      execute: async (action_id: string) => {
        executed.push(action_id)
        return { data: { products: [] } }
      },
    } as unknown as ConnectLike
    const source = createConnectRecordSource({
      connect,
      connections: {
        liveConnections: () =>
          opts.connector === true
            ? [{ id: 'cxn_shop', service: 'shopify_admin', status: 'active' as const }]
            : [],
      },
      clock: { now: () => NOW },
      workspace_id: 'ws_a' as WorkspaceId,
      cloudShop: async () => undefined,
      cliShop: async () =>
        opts.cli === true
          ? {
              query: async ({ document }: { document: string }) => {
                sent.push(document)
                return {
                  products: {
                    nodes: [
                      {
                        id: 'gid://shopify/Product/1001',
                        title: 'Rovella 折叠收纳箱',
                        variants: { nodes: [{ id: 'v1', sku: 'RO-2001', price: '29.90' }] },
                      },
                    ],
                  },
                } as never
              },
            }
          : undefined,
    })
    const run = (name: string, input: Record<string, unknown>) =>
      source.executeTool?.({
        name,
        input,
        request: {
          actor: { person_id: 'p', assignment_id: 'asg', role_id: 'dtc.support' },
          tools: { allow: [name], connect_token: '', side_effect_policy: 'executor' },
        } as unknown as RunRequest,
      })
    return { run, executed, sent }
  }

  it('云端、连接器都没有 → 用 CLI 店铺授权查；连接器在时仍优先连接器', async () => {
    const cli = make({ cli: true })
    const out = await cli.run('list_products', { query: 'rovella' })
    expect(out?.status).toBe('ok')
    expect(out?.data).toMatchObject({ products: [{ title: 'Rovella 折叠收纳箱' }] })
    expect(cli.sent.length).toBeGreaterThan(0)
    const both = make({ cli: true, connector: true })
    await both.run('list_products', {})
    expect(both.sent).toEqual([])
    expect(both.executed).toEqual(['shopify_admin.list_products'])
    const none = make({})
    expect((await none.run('list_products', {}))?.reason).toMatch(/^not_connected/)
  })
})
