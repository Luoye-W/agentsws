/**
 * WP61 的**集成**：WP58 签出来的那把工作区服务令牌，真的能在这个进程里
 * 浏览公共库、付费 reveal；撤掉之后当场就进不来了。
 *
 * `packages/kol-public` 那边的测试钉的是逻辑（配额、去重、奖励、k-匿名、驻留）。
 * 这里钉的是另一件事：**账号库签的令牌与公共库的鉴权真的对得上**，
 * 而且钱是从同一个钱包里扣的（一个账号一个余额，49 §0）。
 */
import { DEFAULT_CLOUD_SCOPES } from '@agentsws/contracts'
import { MemoryKolStore } from '@agentsws/kol-public'
import { MemoryWalletStore } from '@agentsws/metering'
import { afterEach, describe, expect, it } from 'vitest'
import { mountEntry } from '../src/entry.js'
import { type MountedKolPublic, mountKolPublic } from '../src/kol-public.js'
import { type Harness, harness } from './helpers.js'

/** 只在测试里用的一把邮箱密钥（32 字节）。 */
const TEST_EMAIL_KEY = Buffer.alloc(32, 3).toString('base64url')

let h: Harness | undefined
let kol: MountedKolPublic | undefined

afterEach(async () => {
  kol?.close()
  kol = undefined
  await h?.close()
  h = undefined
})

function setup(): { h: Harness; token: string; linkId: string; kol: MountedKolPublic } {
  const harnessed = harness()
  h = harnessed
  const entry = mountEntry(harnessed.server, {
    clock: harnessed.clock,
    walletStore: new MemoryWalletStore(),
  })
  const { account, org } = harnessed.server.store.ensureAccount('luoye@example.com')
  entry.wallet.topup({ org_id: org.id, credits: 1_000, kind: 'purchased' })
  const issued = harnessed.server.store.createLink({
    workspace_id: 'ws_kol',
    cloud_org_id: org.id,
    created_by: account.id,
    scopes: [...DEFAULT_CLOUD_SCOPES],
  })
  const mounted = mountKolPublic(harnessed.server, {
    wallet: entry.wallet,
    pricing: entry.pricing,
    clock: harnessed.clock,
    store: new MemoryKolStore(),
    env: { AGENTSWS_KOL_EMAIL_KEY: TEST_EMAIL_KEY },
  })
  kol = mounted
  return { h: harnessed, token: issued.token, linkId: issued.link.id, kol: mounted }
}

const observation = (handle: string) => ({
  channel: 'youtube',
  handle,
  followers: 120_000,
  posts_30d: 6,
  engagement_rate: 0.035,
  categories: ['3c'],
  observed_at: '2026-09-14T00:00:00.000Z',
})

describe('49 §6 WP61 公共红人库挂进云进程', () => {
  it('默认签发的那把令牌带 data：能报观察、能浏览、能付费 reveal', async () => {
    const { h: harnessed, token } = setup()

    const reported = await harnessed.call(
      '/v1/data/kol/creators/youtube/somecreator/observations',
      {
        method: 'POST',
        token,
        body: { observations: [observation('somecreator')] },
      },
    )
    expect(reported.status).toBe(201)

    const listed = await harnessed.call('/v1/data/kol/creators?channel=youtube', { token })
    expect(listed.status).toBe(200)
    const creators = (listed.body.data as { creators: { handle: string; has_contact: boolean }[] })
      .creators
    expect(creators.map((c) => c.handle)).toEqual(['somecreator'])
    expect(creators[0]?.has_contact).toBe(false)

    const saved = await harnessed.call('/v1/data/kol/creators/youtube/somecreator/contact', {
      method: 'POST',
      token,
      body: { email: 'hi@creator.com' },
    })
    expect(saved.status).toBe(201)

    const revealed = await harnessed.call('/v1/data/kol/creators/youtube/somecreator/reveal', {
      method: 'POST',
      token,
    })
    expect(revealed.status).toBe(200)
    expect((revealed.body.data as { email: string }).email).toBe('hi@creator.com')
  })

  it('撤掉那把令牌之后当场进不来（401，且不告诉它为什么）', async () => {
    const { h: harnessed, token, linkId } = setup()
    expect((await harnessed.call('/v1/data/kol/creators', { token })).status).toBe(200)
    harnessed.server.store.revokeLink(linkId)
    const after = await harnessed.call('/v1/data/kol/creators', { token })
    expect(after.status).toBe(401)
    const never = await harnessed.call('/v1/data/kol/creators', { token: 'wst_never_existed' })
    expect(never.body.message).toBe(after.body.message)
  })
})
