/**
 * WP165（docs/83 §2 第 5 条）：公共红人库的**契约替身**与真服务在「本机那一半靠得住的几条」上说同一种话。
 *
 * 开源那一侧（`apps/server` 的 `kol-public.test.ts`、`wp131-extension.test.ts` 与两条插件转发的
 * 测试、合成世界）以前起真的 `KolPublicService`，现在打 `@agentsws/stand-ins` 的
 * `KolPublicStandIn`（经 `kolPublicHttp`）。这里拿**同一串 HTTP 动作**同时打真路由与替身：
 * 状态码、错误码、每一步扣了多少积分、钱包还剩多少，逐条比对。
 *
 * 替身不做的（加密、审计、计量事件、基准、驻留、降级）不在比对范围——那些是云端自己的测试。
 */
import type { KolChannel, PublicCreatorObservation } from '@agentsws/contracts'
import {
  cloudStandInFetch,
  KolPublicStandIn,
  type StandInKolPrincipal,
  StandInWallet,
} from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { harness, testClock } from './helpers.js'

const P = '/v1/data/kol'
const T0 = '2026-09-15T00:00:00.000Z'

const obs = (handle: string, i: number): PublicCreatorObservation => ({
  channel: 'youtube',
  handle,
  followers: 50_000,
  posts_30d: 8,
  engagement_rate: 0.04,
  categories: ['3c'],
  observed_at: new Date(Date.parse('2026-09-10T00:00:00.000Z') + i * 3_600_000).toISOString(),
})

type Step =
  | { op: 'call'; method: 'GET' | 'POST'; path: string; body?: unknown; token?: string }
  | { op: 'topup'; credits: number }
  | { op: 'contact'; handle: string }
  | { op: 'advance'; ms: number }

const SCRIPT: Step[] = [
  // 一分没充：浏览就扣不动（402）
  { op: 'call', method: 'GET', path: `${P}/creators?channel=youtube` },
  { op: 'topup', credits: 20 },
  { op: 'call', method: 'GET', path: `${P}/creators?channel=youtube` },
  // 同一个查询 10 分钟内翻页不重复收；搜到 0 条不收
  { op: 'call', method: 'GET', path: `${P}/creators?channel=youtube&q=gadget` },
  { op: 'call', method: 'GET', path: `${P}/creators?channel=youtube&q=gadget&limit=5` },
  { op: 'call', method: 'GET', path: `${P}/creators?q=nobody` },
  { op: 'advance', ms: 11 * 60_000 },
  { op: 'call', method: 'GET', path: `${P}/creators?channel=youtube&q=gadget` },
  // 取联系方式：没有就不收；有了按 reveal 收；查无此人 404
  { op: 'call', method: 'POST', path: `${P}/creators/youtube/gadgetjonas/reveal` },
  { op: 'contact', handle: 'gadgetjonas' },
  { op: 'call', method: 'POST', path: `${P}/creators/youtube/gadgetjonas/reveal` },
  { op: 'call', method: 'POST', path: `${P}/creators/youtube/nobody/reveal` },
  // 体检：样本够才收；不够照出报告、不收
  { op: 'call', method: 'GET', path: `${P}/creators/youtube/gadgetjonas/audit` },
  { op: 'call', method: 'GET', path: `${P}/creators/youtube/thinsample/audit` },
  // 本机转发的插件观测（via=extension，两格可缺）收下；手填缺两格整批拒
  {
    op: 'call',
    method: 'POST',
    path: `${P}/creators/tiktok/gymchef/observations`,
    body: {
      via: 'extension',
      observations: [{ channel: 'tiktok', handle: 'gymchef', followers: 48_200, observed_at: T0 }],
    },
  },
  {
    op: 'call',
    method: 'POST',
    path: `${P}/creators/tiktok/gymchef/observations`,
    body: {
      observations: [{ channel: 'tiktok', handle: 'gymchef', followers: 1, observed_at: T0 }],
    },
  },
  // 钱不够：体检 402，一分不扣
  { op: 'call', method: 'GET', path: `${P}/creators/youtube/gadgetjonas/audit` },
  { op: 'call', method: 'GET', path: `${P}/creators/youtube/gadgetjonas/audit` },
  { op: 'call', method: 'GET', path: `${P}/creators/youtube/gadgetjonas/audit` },
  { op: 'call', method: 'GET', path: `${P}/creators/youtube/gadgetjonas/audit` },
  { op: 'call', method: 'GET', path: `${P}/creators/youtube/gadgetjonas/audit` },
  { op: 'call', method: 'GET', path: `${P}/creators/youtube/gadgetjonas/audit` },
  { op: 'call', method: 'GET', path: `${P}/creators/youtube/gadgetjonas/audit` },
  // 令牌不认识 401
  { op: 'call', method: 'GET', path: `${P}/creators`, token: 'wst_nope' },
]

interface Outcome {
  status: number
  code?: unknown
  credits?: unknown
  balance: number
}

/** 从回执里挑出要比的那几格：状态码、错误码、扣了多少。 */
function pick(status: number, body: Record<string, unknown>): Omit<Outcome, 'balance'> {
  const data = body.data as Record<string, unknown> | undefined
  return {
    status,
    ...(body.code === undefined ? {} : { code: body.code }),
    ...(data?.credits === undefined ? {} : { credits: data.credits }),
  }
}

describe('WP165 公共红人库：契约替身与真服务逐条一致', () => {
  it('同一串动作：状态码、错误码、每步扣的积分、钱包余额都一样', async () => {
    // —— 真服务（内存档 + 真钱包 + 真价目）
    const clock = testClock(T0)
    const real = harness({ clock })
    const seed = (into: (o: PublicCreatorObservation[]) => void): void => {
      into([0, 1, 2].map((i) => obs('gadgetjonas', i)))
      into([obs('thinsample', 0)])
    }
    const principal: StandInKolPrincipal = {
      account_id: 'acc_1',
      org_id: 'org_1',
      workspace_id: 'ws_1',
      scopes: ['ai', 'wallet:read', 'data'],
    }
    seed((o) => real.service.contributeAs(principal, o))

    // —— 替身（同一个钟、同一份价目样例）
    let seq = 0
    const newId = (p: string): string => `${p}_${String(++seq)}`
    const wallet = new StandInWallet({ now: () => clock.now(), newId })
    const kol = new KolPublicStandIn({ wallet, now: () => clock.now(), newId })
    seed((o) => kol.contributeAs(principal, o))
    const token = 'wst_stand_in_token'
    const wire = cloudStandInFetch({
      kolPublic: kol,
      kolPrincipalOf: (t) => (t === token ? principal : undefined),
    })

    for (const [i, step] of SCRIPT.entries()) {
      if (step.op === 'advance') {
        clock.advance(step.ms)
        continue
      }
      if (step.op === 'topup') {
        real.wallet.topup({ org_id: 'org_1', credits: step.credits, kind: 'purchased' })
        wallet.topup({ org_id: 'org_1', credits: step.credits, kind: 'purchased' })
        continue
      }
      if (step.op === 'contact') {
        const key = { channel: 'youtube' as KolChannel, handle: step.handle }
        real.service.saveContact(
          { id: 'ws:ws_1', workspace_id: 'ws_1', org_id: 'org_1', kind: 'workspace' },
          key,
          { email: `${step.handle}@creator.test` },
        )
        kol.saveContact({}, key, { email: `${step.handle}@creator.test` })
        continue
      }
      const want = await real.call(step.path, {
        method: step.method,
        ...(step.body === undefined ? {} : { body: step.body }),
        ...(step.token === undefined ? {} : { token: step.token }),
      })
      const res = await wire.fetch(`http://cloud.test${step.path}`, {
        method: step.method,
        headers: { Authorization: `Bearer ${step.token ?? token}` },
        ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
      })
      const got = { status: res.status, body: (await res.json()) as Record<string, unknown> }
      const a: Outcome = {
        ...pick(want.status, want.body),
        balance: real.wallet.balance('org_1').available,
      }
      const b: Outcome = {
        ...pick(got.status, got.body),
        balance: wallet.balance('org_1').available,
      }
      expect(b, `第 ${String(i)} 步 ${step.method} ${step.path}`).toEqual(a)
    }
    // 这串动作真的走到了扣钱与被拦两种分支
    expect(real.wallet.balance('org_1').available).toBeLessThan(20)
  })

  it('少了 data 动作集：两边都是 403 + required_scope（本机据此说「重新关联一次」）', async () => {
    const real = harness({ scopes: ['ai', 'wallet:read'] })
    const want = await real.call(`${P}/creators`)
    const narrow: StandInKolPrincipal = {
      account_id: 'acc_1',
      org_id: 'org_1',
      workspace_id: 'ws_1',
      scopes: ['ai', 'wallet:read'],
    }
    const kol = new KolPublicStandIn({
      wallet: new StandInWallet({ now: () => T0, newId: (p) => p }),
      now: () => T0,
      newId: (p) => p,
    })
    const wire = cloudStandInFetch({
      kolPublic: kol,
      kolPrincipalOf: () => narrow,
    })
    const res = await wire.fetch(`http://cloud.test${P}/creators`, {
      headers: { Authorization: 'Bearer wst_x' },
    })
    const got = (await res.json()) as { code?: string; details?: { required_scope?: string } }
    expect(res.status).toBe(want.status)
    expect(got.code).toBe(want.body.code)
    expect(got.details?.required_scope).toBe(
      (want.body.details as { required_scope?: string }).required_scope,
    )
  })
})
