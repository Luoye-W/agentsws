/**
 * WP121（70 §2）：注册赠送 10 积分 —— Compose 形态。
 *
 * Workers 形态那一份在 `apps/cloud-worker/test/`（同一个 `grantSignupBonus`，
 * 差的只有"钱在哪"），所以这里验的是**规则本身**：什么时候送、什么时候不送、
 * 送不出去的时候登录还能不能成。
 *
 * 全内存、不联网、不花钱。
 */

import { syncDbFromBetterSqlite } from '@agentsws/core/sql/sync-db'
import {
  createSqliteWalletStore,
  isSignupBonusRef,
  signupBonus,
  signupBonusSourceRef,
  sqlWalletAdminPort,
  Wallet,
} from '@agentsws/metering'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AdminStore,
  createAdminStore,
  grantSignupBonus,
  type SignupBonusLedger,
  type SignupBonusPort,
} from '../src/index.js'
import { harness, type TestClock, testClock } from './helpers.js'

/** `bonuses.json` 里那个数。用例不写死 10。 */
const BONUS = signupBonus()?.credits ?? 0

interface Fixture {
  h: ReturnType<typeof harness>
  clock: TestClock
  admin: AdminStore
  wallet: Wallet
  store: ReturnType<typeof createSqliteWalletStore>
  close(): Promise<void>
}

/**
 * 一套装好赠送的 Compose 云端。
 *
 * 与 `apps/cloud/src/index.ts` 里 `main()` 那段装配是**同一个形状**（两个取值
 * 函数 + 真的钱包 + 真的后台库），只是库都在内存里。
 */
function fixture(options: { bonus?: boolean } = {}): Fixture {
  const clock = testClock()
  const store = createSqliteWalletStore({ dbPath: ':memory:', now: () => clock.now() })
  let seq = 0
  const wallet = new Wallet({
    store,
    now: () => clock.now(),
    newId: (prefix) => `${prefix}_${String(++seq).padStart(6, '0')}`,
    onEvent: () => {},
  })
  const port = sqlWalletAdminPort({
    db: syncDbFromBetterSqlite(store.db),
    wallet,
    appendEvent: (e) => {
      store.appendEvent(e)
    },
  })
  let adminStore: AdminStore | undefined
  const h = harness({
    clock,
    ...(options.bonus === false
      ? {}
      : {
          signupBonus: {
            port: () => ({ grant: (args) => port.grant(args) }),
            ledger: () => adminStore,
            warn: () => {},
          },
        }),
  })
  adminStore = createAdminStore(h.server, clock)
  return {
    h,
    clock,
    admin: adminStore,
    wallet,
    store,
    async close() {
      store.close()
      await h.close()
    },
  }
}

/** 走一遍真实的登录：发信 → 从信里取 token → 点链接。 */
async function signIn(
  f: Fixture,
  email: string,
): Promise<{ status: number; body: { data?: unknown; code?: string } }> {
  const sent = await f.h.call('/v1/cloud/auth/magic-link', {
    method: 'POST',
    body: { email, callback_url: 'http://127.0.0.1:7788/cb' },
  })
  expect(sent.status, JSON.stringify(sent.body)).toBe(200)
  const mail = f.h.mails.at(-1)
  if (mail === undefined) throw new Error('没发出信')
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1]
  if (token === undefined) throw new Error(`信里没有 token：${mail.text}`)
  return f.h.call('/v1/cloud/auth/verify', { method: 'POST', body: { token } })
}

type VerifyBody = {
  account: { id: string }
  org: { id: string }
  bonus?: { granted: boolean; credits: number; expires_at?: string; skip?: string }
}

const bodyOf = (res: { body: { data?: unknown } }): VerifyBody => res.body.data as VerifyBody

let open: Fixture | undefined
afterEach(async () => {
  await open?.close()
  open = undefined
})

/** 建一套并登记给 `afterEach` 关（每条用例一套，库都在内存里）。 */
function use(options: { bonus?: boolean } = {}): Fixture {
  open = fixture(options)
  return open
}

describe('WP121 · 注册赠送（Compose 形态）', () => {
  it('点开登录信那一刻到账，是 granted 那一类，90 天后到期', async () => {
    const f = use()
    const res = await signIn(f, 'new@example.com')
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const out = bodyOf(res)
    expect(out.bonus?.granted).toBe(true)
    expect(out.bonus?.credits).toBe(BONUS)
    expect(f.wallet.balance(out.org.id).granted).toBe(BONUS)

    // 90 天：钱真的带着到期日进了库，不只是响应里那句话
    const lot = f.store.lots(out.org.id).find((l) => isSignupBonusRef(l.source_ref))
    expect(lot?.kind).toBe('granted')
    expect(lot?.expires_at).toBe(out.bonus?.expires_at)
    const days =
      (Date.parse(out.bonus?.expires_at ?? '') - Date.parse(f.clock.now())) / (24 * 60 * 60 * 1000)
    expect(Math.round(days)).toBe(90)

    // 幂等键里没有时间、没有邮箱、没有金额
    expect(lot?.source_ref).toBe(signupBonusSourceRef(out.account.id))
  })

  it('同一个账号反复点登录信：只送一次', async () => {
    const f = use()
    const first = bodyOf(await signIn(f, 'again@example.com'))
    expect(first.bonus?.granted).toBe(true)

    // 第二封信是同一个账号（`ensureAccount` 认邮箱），所以是同一串 source_ref
    const second = bodyOf(await signIn(f, 'again@example.com'))
    expect(second.account.id).toBe(first.account.id)
    expect(second.bonus?.granted).toBe(false)
    expect(second.bonus?.skip).toBe('already')
    expect(f.wallet.balance(first.org.id).granted).toBe(BONUS)
  })

  it('换个 +tag 再注册一个账号：是两个账号，但只送一份', async () => {
    const f = use()
    const first = bodyOf(await signIn(f, 'a.b+one@gmail.com'))
    expect(first.bonus?.granted).toBe(true)

    // 别名规范化之后是同一个人（WP115 的 `normalizeEmailAlias`）
    const second = bodyOf(await signIn(f, 'ab+two@gmail.com'))
    expect(second.account.id).not.toBe(first.account.id)
    expect(second.bonus?.granted).toBe(false)
    expect(second.bonus?.skip).toBe('already')
    // 第二个组织一分钱没有
    expect(f.wallet.balance(second.org.id).granted).toBe(0)
  })

  it('黑名单邮箱：一分不送，但照样登得进去', async () => {
    const f = use()
    f.admin.banEmail('gone@example.com', '删号封邮箱', 'acc_staff')

    const res = await signIn(f, 'gone@example.com')
    expect(res.status).toBe(200) // 登录成功——赠送与登录是两件事
    const out = bodyOf(res)
    expect(out.bonus?.granted).toBe(false)
    expect(out.bonus?.skip).toBe('blocked')
    expect(f.wallet.balance(out.org.id).granted).toBe(0)
  })

  it('钱包炸了：登录照样成，只是没到账，并且留下一条 failed 审计', async () => {
    const f = use({ bonus: false })
    const ledger: SignupBonusLedger = {
      signupBonusOf: () => undefined,
      recordSignupBonus: () => {
        throw new Error('不该走到这一步')
      },
      emailBanned: () => false,
      audit: (e) => audits.push(e),
    }
    const audits: { outcome: string; details?: Record<string, unknown> }[] = []
    const port: SignupBonusPort = {
      grant: async () => {
        throw new Error('上游炸了')
      },
    }
    const out = await grantSignupBonus(
      { clock: f.clock, hooks: { port: () => port, ledger: () => ledger, warn: () => {} } },
      { account_id: 'acc_1', org_id: 'org_1', email: 'boom@example.com' },
    )
    expect(out.granted).toBe(false)
    expect(out.skip).toBe('failed')
    expect(audits.at(-1)?.outcome).toBe('failed')
    // 审计里**一个邮箱字都没有**（21 §1）
    expect(JSON.stringify(audits)).not.toContain('boom@example.com')
  })

  it('这个节点没装钱包（开源自建档）：不送，也不假装送过了', async () => {
    const f = use({ bonus: false })
    const out = await grantSignupBonus(
      { clock: f.clock, hooks: { port: () => undefined, ledger: () => undefined } },
      { account_id: 'acc_1', org_id: 'org_1', email: 'selfhost@example.com' },
    )
    expect(out).toEqual({ granted: false, credits: 0, skip: 'unavailable' })
  })

  it('`bonuses.json` 里把金额改成 0：这个部署就是不送', async () => {
    const f = use({ bonus: false })
    const out = await grantSignupBonus(
      {
        clock: f.clock,
        hooks: {
          rule: {
            id: 'signup_bonus',
            label_zh: '关了',
            label_en: 'off',
            credits: 0,
            kind: 'granted',
          },
          port: () => ({ grant: async () => ({ lot_id: 'never' }) }),
          ledger: () => f.admin,
        },
      },
      { account_id: 'acc_1', org_id: 'org_1', email: 'off@example.com' },
    )
    expect(out.skip).toBe('disabled')
  })

  it('没交赠送那两个口的节点：响应里连 bonus 这个字段都没有', async () => {
    const f = use({ bonus: false })
    const out = bodyOf(await signIn(f, 'plain@example.com'))
    expect(out.bonus).toBeUndefined()
  })
})
