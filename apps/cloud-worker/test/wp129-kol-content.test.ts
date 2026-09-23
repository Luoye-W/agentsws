/**
 * WP129：`KolPublicDO` 上的两件小事，都从**入口 Worker** 进（真链路：验令牌 →
 * `WalletDO` 预扣 → 单例 `KolPublicDO` → 回 `WalletDO` 照单执行）。
 *
 * 1. 内容观测进公共库：不收费；落进 `kol_contents` / 标识旁表 / 指标表；
 *    同一条内容同一天只记一行；贡献**不发积分**（09-23 Luoye 定，WP130 改），钱包一分不动；
 * 2. 体检报告样本不够不收钱：入口按 `data.kol.audit` 预扣的那一笔被兜底释放，
 *    报告里明说「样本不够，这次不收。」；样本够了照价收。
 *
 * 全部替身，不联网。
 */

import { DEFAULT_CLOUD_SCOPES, OBSERVATIONS_PER_CREDIT } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { route } from '../src/index.js'
import { type FakeCloud, fakeCloud, req, tokenFromMail } from './helpers.js'

const CALLBACK = 'http://127.0.0.1:3000/v1/cloud/account/callback'

interface Json {
  data?: unknown
  code?: string
  message?: string
}

async function call(
  cloud: FakeCloud,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: Json }> {
  const headers = new Headers()
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
  const res = await route(
    req(path, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    cloud.env,
  )
  const text = await res.text()
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Json) }
}

async function issueToken(
  cloud: FakeCloud,
  email: string,
  workspace_id: string,
): Promise<{ token: string; org: string }> {
  await call(cloud, '/v1/cloud/auth/magic-link', {
    method: 'POST',
    body: { email, callback_url: CALLBACK },
  })
  const oneTime = tokenFromMail(cloud.mails[cloud.mails.length - 1] as never)
  const verified = await call(cloud, '/v1/cloud/auth/verify', {
    method: 'POST',
    body: { token: oneTime },
  })
  const data = verified.body.data as { session_token: string; org: { id: string } }
  const link = await call(cloud, '/v1/cloud/links', {
    method: 'POST',
    token: data.session_token,
    body: { workspace_id, scopes: DEFAULT_CLOUD_SCOPES },
  })
  return { token: (link.body.data as { token: string }).token, org: data.org.id }
}

async function available(cloud: FakeCloud, token: string): Promise<number> {
  const wallet = await call(cloud, '/v1/wallet', { token })
  return (wallet.body.data as { available: number }).available
}

const content = (i: number, overrides: Record<string, unknown> = {}) => ({
  channel: 'youtube',
  handle: 'somecreator',
  external_id: `vid${i}`,
  content_type: 'video',
  title: `Video ${i}`,
  duration_seconds: 300,
  views: 1_000 + i,
  likes: 50,
  comments: 7,
  paid_promotion: i % 2 === 0,
  shoppable: true,
  observed_at: '2026-09-14T08:00:00.000Z',
  ...overrides,
})

describe('WP129 · 内容观测经 KolPublicDO 进公共库', () => {
  it('不收费；落进内容卡、标识旁表与指标表；同一天重复只记一行', async () => {
    const cloud = fakeCloud({ kol: true })
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_a')
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 10, kind: 'purchased' })
    const before = await available(cloud, token)

    const first = await call(cloud, '/v1/data/kol/content-observations', {
      method: 'POST',
      token,
      body: { observations: [content(0)] },
    })
    expect(first.status).toBe(201)
    expect(first.body.data).toMatchObject({ kind: 'content', accepted: 1 })
    const again = await call(cloud, '/v1/data/kol/content-observations', {
      method: 'POST',
      token,
      body: { observations: [content(0, { views: 5_000, observed_at: '2026-09-14T09:00:00Z' })] },
    })
    expect(again.body.data).toMatchObject({ accepted: 0 })
    expect(await available(cloud, token)).toBe(before)

    expect(cloud.kol().contentReady).toBe(true)
    const db = cloud.kol().store.db
    expect(db.prepare('select views from kol_contents').all()).toEqual([{ views: 5_000 }])
    expect(db.prepare('select paid_promotion, shoppable from kol_content_flags').all()).toEqual([
      { paid_promotion: 1, shoppable: 1 },
    ])
    expect(db.prepare('select count(*) as n from kol_content_metrics').get()).toEqual({ n: 1 })
  })

  it('评论文本整批拒（400），库里一行都不多', async () => {
    const cloud = fakeCloud({ kol: true })
    const { token } = await issueToken(cloud, 'b@example.com', 'ws_b')
    const res = await call(cloud, '/v1/data/kol/content-observations', {
      method: 'POST',
      token,
      body: { observations: [{ ...content(1), captured_comments: [{ text: 'hi' }] }] },
    })
    expect(res.status).toBe(400)
    expect(cloud.kol().store.db.prepare('select count(*) as n from kol_contents').get()).toEqual({
      n: 0,
    })
  })

  it('贡献不发积分（09-23 Luoye 定）：录音机里没有 granted 那一笔，报数据那个组织的余额不动', async () => {
    const cloud = fakeCloud({ kol: true })
    const a = await issueToken(cloud, 'c@example.com', 'ws_c')
    const before = await available(cloud, a.token)
    const batch = Array.from({ length: OBSERVATIONS_PER_CREDIT }, (_, i) => content(i))
    const res = await call(cloud, '/v1/data/kol/content-observations', {
      method: 'POST',
      token: a.token,
      body: { observations: batch },
    })
    expect(res.status).toBe(201)
    expect((res.body.data as { credits_granted: number }).credits_granted).toBe(0)
    expect((await available(cloud, a.token)) - before).toBeCloseTo(0, 6)
  })
})

describe('WP129 · 体检报告样本不够不收钱（Workers 形态）', () => {
  async function seed(cloud: FakeCloud, token: string, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const res = await call(cloud, '/v1/data/kol/creators/youtube/somecreator/observations', {
        method: 'POST',
        token,
        body: {
          followers: 120_000 + i,
          posts_30d: 12,
          engagement_rate: 0.03,
          observed_at: new Date(Date.parse('2026-09-10T00:00:00Z') + i * 3_600_000).toISOString(),
        },
      })
      expect(res.status).toBe(201)
    }
  }

  it('样本不够：入口那笔预扣被释放，报告明说「样本不够，这次不收。」', async () => {
    const cloud = fakeCloud({ kol: true })
    const { token, org } = await issueToken(cloud, 'd@example.com', 'ws_d')
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 10, kind: 'purchased' })
    await seed(cloud, token, 1)
    const before = await available(cloud, token)
    for (const [path, method] of [
      ['/v1/data/kol/creators/youtube/somecreator/audit', 'GET'],
      ['/v1/data/kol/creators/youtube/somecreator/deep-audit', 'POST'],
    ] as const) {
      const res = await call(cloud, path, { method, token })
      expect(res.status).toBe(200)
      const report = res.body.data as {
        insufficient_samples: boolean
        credits: number
        note: string
      }
      expect(report.insufficient_samples).toBe(true)
      expect(report.credits).toBe(0)
      expect(report.note).toContain('样本不够，这次不收。')
    }
    expect(await available(cloud, token)).toBe(before)
  })

  it('样本够了照价收 3 积分', async () => {
    const cloud = fakeCloud({ kol: true })
    const { token, org } = await issueToken(cloud, 'e@example.com', 'ws_e')
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 10, kind: 'purchased' })
    await seed(cloud, token, 3)
    const before = await available(cloud, token)
    const res = await call(cloud, '/v1/data/kol/creators/youtube/somecreator/audit', { token })
    expect(res.status).toBe(200)
    expect((res.body.data as { credits: number }).credits).toBe(3)
    expect(before - (await available(cloud, token))).toBeCloseTo(3, 6)
  })
})
