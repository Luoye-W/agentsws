/** 公共库测试的共用装配：可推的钟、内存库、内存钱包、假令牌验证器。 */
import type { CloudScope, PublicCreatorObservation, VerifiedCloudToken } from '@agentsws/contracts'
import { buildPricing, MemoryWalletStore, Wallet } from '@agentsws/metering'
import type { Hono } from 'hono'
import { type KolEnv, type KolSecrets, MemoryKolStore, type SourceLookup } from '../src/index.js'
import { nodeKolSecrets } from '../src/node-crypto.js'
import { createKolPublicApp } from '../src/routes.js'
import { KolPublicService } from '../src/service.js'

/** 32 字节的测试密钥（**只是一个测试固定值**，不是任何环境里用的那把）。 */
export const TEST_EMAIL_KEY = Buffer.alloc(32, 7).toString('base64url')

export interface TestClock {
  now(): string
  advance(ms: number): void
}

export function testClock(start = '2026-09-15T00:00:00.000Z'): TestClock {
  let at = Date.parse(start)
  return {
    now: () => new Date(at).toISOString(),
    advance: (ms) => {
      at += ms
    },
  }
}

export interface Harness {
  app: Hono<KolEnv>
  service: KolPublicService
  store: MemoryKolStore
  wallet: Wallet
  walletStore: MemoryWalletStore
  secrets: KolSecrets
  clock: TestClock
  token: string
  call(
    path: string,
    init?: {
      method?: string
      body?: unknown
      token?: string
      region?: string
      headers?: Record<string, string>
    },
  ): Promise<{ status: number; body: Record<string, unknown> }>
}

export interface HarnessOptions {
  scopes?: CloudScope[]
  credits?: number
  sources?: SourceLookup
  emailKey?: string | undefined
  clock?: TestClock
}

export function harness(options: HarnessOptions = {}): Harness {
  const clock = options.clock ?? testClock()
  const store = new MemoryKolStore()
  const walletStore = new MemoryWalletStore()
  let seq = 0
  const newId = (prefix: string): string => `${prefix}_${String(++seq)}`
  const wallet = new Wallet({ store: walletStore, now: () => clock.now(), newId })
  const secrets = nodeKolSecrets({
    env: { AGENTSWS_KOL_EMAIL_KEY: options.emailKey ?? TEST_EMAIL_KEY },
  })
  const service = new KolPublicService({
    store,
    wallet,
    pricing: buildPricing(),
    secrets,
    now: () => clock.now(),
    newId,
    ...(options.sources === undefined ? {} : { sources: options.sources }),
    newRequestId: () => `req_${String(++seq)}`,
  })
  const scopes: CloudScope[] = options.scopes ?? ['ai', 'wallet:read', 'data']
  const token = 'wst_test_token'
  const verified: VerifiedCloudToken = {
    account_id: 'acc_1',
    org_id: 'org_1',
    workspace_id: 'ws_1',
    scopes,
  }
  const app = createKolPublicApp({
    service,
    verifier: (candidate: string) => Promise.resolve(candidate === token ? verified : undefined),
  })
  if (options.credits !== undefined && options.credits > 0)
    wallet.topup({ org_id: 'org_1', credits: options.credits, kind: 'purchased' })

  return {
    app,
    service,
    store,
    wallet,
    walletStore,
    secrets,
    clock,
    token,
    async call(path, init = {}) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      }
      const bearer = init.token === undefined ? token : init.token
      if (bearer !== '') headers.Authorization = `Bearer ${bearer}`
      if (init.region !== undefined) headers['X-Agentsws-Region'] = init.region
      const res = await app.request(`http://cloud.test${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
      const text = await res.text()
      return {
        status: res.status,
        body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
      }
    },
  }
}

/** 一条能过白名单的观察（测试里到处要用）。 */
export function observation(
  overrides: Partial<PublicCreatorObservation> = {},
): PublicCreatorObservation {
  return {
    channel: 'youtube',
    handle: 'somecreator',
    followers: 50_000,
    posts_30d: 8,
    engagement_rate: 0.04,
    categories: ['3c'],
    observed_at: '2026-09-14T00:00:00.000Z',
    ...overrides,
  }
}
