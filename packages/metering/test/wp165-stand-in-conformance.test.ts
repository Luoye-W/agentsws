/**
 * WP165（docs/83 §2 第 5 条）：钱包的**契约替身**（`@agentsws/stand-ins` 的 `StandInWallet`，
 * 合成世界与 `apps/server` 的测试在用）与真钱包记的是同一本账。
 *
 * 同一串动作（两类积分、到期、先扣有期限的、预扣 / 结算 / 释放、余额不够只拒这一次、
 * 同一个订单号只入一次）同时喂两边，每一步之后余额逐格比对；拒的那一次码与那句人话也要一样。
 */
import {
  bonusExpiresAtOf,
  SAMPLE_SIGNUP_BONUS,
  StandInWallet,
  StandInWalletError,
  signupBonusSourceRefOf,
} from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { bonusExpiresAt, signupBonus, signupBonusSourceRef } from '../src/bonuses.js'
import { MemoryWalletStore, Wallet, WalletError } from '../src/wallet.js'

type Step =
  | { op: 'topup'; credits: number; kind: 'purchased' | 'granted'; days?: number; ref?: string }
  | { op: 'reserve'; credits: number; key: string }
  | { op: 'settle'; key: string; credits: number }
  | { op: 'release'; key: string }
  | { op: 'advance'; days: number }

const DAY = 86_400_000

const SCRIPT: Step[] = [
  { op: 'topup', credits: 10, kind: 'granted', days: 90, ref: 'signup_bonus:acc_1' },
  { op: 'topup', credits: 10, kind: 'granted', days: 90, ref: 'signup_bonus:acc_1' },
  { op: 'topup', credits: 5, kind: 'granted', days: 30 },
  { op: 'topup', credits: 20, kind: 'purchased' },
  { op: 'reserve', credits: 3.3333, key: 'r1' },
  { op: 'settle', key: 'r1', credits: 4.12345 },
  { op: 'reserve', credits: 2, key: 'r2' },
  { op: 'release', key: 'r2' },
  { op: 'reserve', credits: 1000, key: 'r3' },
  { op: 'advance', days: 31 },
  { op: 'reserve', credits: 12, key: 'r4' },
  { op: 'settle', key: 'r4', credits: 12 },
  { op: 'advance', days: 60 },
  { op: 'reserve', credits: 0.2, key: 'r5' },
  { op: 'settle', key: 'r5', credits: 0 },
  { op: 'reserve', credits: 50, key: 'r6' },
]

describe('WP165 钱包：契约替身与真钱包逐步一致', () => {
  it('同一串动作：每一步之后余额逐格一样；拒的那一次码与人话一样', () => {
    let t = Date.parse('2026-09-19T00:00:00.000Z')
    const now = (): string => new Date(t).toISOString()
    let seq = 0
    const newId = (p: string): string => `${p}_${String(++seq)}`
    const real = new Wallet({ store: new MemoryWalletStore(), now, newId })
    const fake = new StandInWallet({ now, newId })
    const held = new Map<string, { real: unknown; fake: unknown }>()
    const reserveArgs = (credits: number, key: string) => ({
      org_id: 'org_1',
      workspace_id: 'ws_1',
      capability: 'ai.chat',
      unit: 'call',
      quantity: 1,
      credits,
      request_id: key,
    })
    const outcome = (fn: () => unknown): unknown => {
      try {
        fn()
        return 'ok'
      } catch (err) {
        if (err instanceof WalletError || err instanceof StandInWalletError)
          return { code: err.code, message: err.message }
        throw err
      }
    }
    for (const [i, step] of SCRIPT.entries()) {
      let a: unknown = 'ok'
      let b: unknown = 'ok'
      if (step.op === 'advance') t += step.days * DAY
      if (step.op === 'topup') {
        const expires_at =
          step.days === undefined ? undefined : new Date(t + step.days * DAY).toISOString()
        const args = {
          org_id: 'org_1',
          credits: step.credits,
          kind: step.kind,
          ...(expires_at === undefined ? {} : { expires_at }),
          ...(step.ref === undefined ? {} : { source_ref: step.ref }),
        }
        a = outcome(() => real.topup(args))
        b = outcome(() => fake.topup(args))
      }
      if (step.op === 'reserve') {
        const r = { real: undefined as unknown, fake: undefined as unknown }
        a = outcome(() => {
          r.real = real.reserve(reserveArgs(step.credits, step.key))
        })
        b = outcome(() => {
          r.fake = fake.reserve(reserveArgs(step.credits, step.key))
        })
        held.set(step.key, r)
      }
      if (step.op === 'settle') {
        const r = held.get(step.key)
        real.settle(r?.real as never, { quantity: 1, credits: step.credits })
        fake.settle(r?.fake as never, { quantity: 1, credits: step.credits })
      }
      if (step.op === 'release') {
        const r = held.get(step.key)
        real.release(r?.real as never)
        fake.release(r?.fake as never)
      }
      expect(b, `第 ${String(i)} 步（${step.op}）的结果`).toEqual(a)
      const { at: _a, ...rb } = real.balance('org_1')
      const { at: _b, ...fb } = fake.balance('org_1')
      expect(fb, `第 ${String(i)} 步（${step.op}）之后的余额`).toEqual(rb)
    }
  })

  it('注册赠送样例与云上规则、幂等键、到期日同形', () => {
    const rule = signupBonus()
    expect(rule).toBeDefined()
    expect(SAMPLE_SIGNUP_BONUS).toMatchObject({
      credits: rule?.credits,
      kind: rule?.kind,
      expires_days: rule?.expires_days,
    })
    expect(signupBonusSourceRefOf('acc_1')).toBe(signupBonusSourceRef('acc_1'))
    const at = '2026-09-19T00:00:00.000Z'
    expect(bonusExpiresAtOf(SAMPLE_SIGNUP_BONUS, at)).toBe(
      bonusExpiresAt(rule as NonNullable<typeof rule>, at),
    )
  })
})
