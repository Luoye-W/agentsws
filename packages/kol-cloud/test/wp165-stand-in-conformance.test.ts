/**
 * WP165（docs/83 §2 第 5 条）：同步协议的**契约替身**与真服务说的是同一种话。
 *
 * 开源那一侧（`apps/server` 的 `kol-cloud-sync.test.ts`）以前直接拿真的 `KolCloudService`
 * 当对面，现在换成 `@agentsws/stand-ins` 的 `KolSyncStandIn`。为了不变成「两边各按各的理解
 * 写了一遍、刚好一致」，这里拿**同一串动作**同时喂真服务（真 sqlite 内存库）与替身，
 * 回执逐条比对。协议哪天改了而替身没跟上，这一条先红。
 *
 * 另外钉一条只属于云端的：库里存的是**可读的正文 JSON**（67 §1：云端要读得懂数据）——
 * 这条以前在 `apps/server` 那边查云端的库，现在挪到这里。
 */
import type { KolSyncObject, KolSyncPushRequest } from '@agentsws/contracts'
import { KolSyncStandIn, StandInKolSyncError } from '@agentsws/stand-ins'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { KolCloudService } from '../src/service.js'
import { KolCloudStore } from '../src/store.js'
import { KolCloudError, type SqliteLike, type SubscriptionWallet } from '../src/types.js'

const PRINCIPAL = { account_id: 'acc_1', org_id: 'org_1', workspace_id: 'ws_1', scopes: ['kol'] }

const obj = (
  id: string,
  version: number,
  updated_at: string,
  writer: string,
  over: Partial<KolSyncObject> = {},
): KolSyncObject => ({
  kind: 'creator',
  id,
  version,
  updated_at,
  writer,
  body: { id, display_name: `${id}@${writer}` },
  ...over,
})

type Step =
  | { op: 'push'; request: KolSyncPushRequest }
  | { op: 'pull'; args: { cursor?: string; writer?: string; limit?: number } }
  | { op: 'status' }
  | { op: 'conflicts' }
  | { op: 'resolve'; input: { kind: string; id: string } }
  | { op: 'export' }
  | { op: 'tick' }

/** 一串覆盖协议各个分支的动作。 */
const SCRIPT: Step[] = [
  { op: 'push', request: { writer: 'device:a', objects: [] } },
  {
    op: 'push',
    request: {
      writer: 'device:a',
      objects: [
        obj('cre_1', 1, '2026-02-01T00:00:01.000Z', 'device:a'),
        obj('cre_2', 1, '2026-02-01T00:00:01.000Z', 'device:a'),
        obj('ctc_1', 1, '2026-02-01T00:00:01.000Z', 'device:a', {
          kind: 'creator_contact',
          body: { id: 'ctc_1', value_ref: 'kol_email:cre_1' },
        }),
      ],
    },
  },
  { op: 'tick' },
  // 一模一样再推一次：不算写、不算冲突
  {
    op: 'push',
    request: {
      writer: 'device:a',
      objects: [obj('cre_1', 1, '2026-02-01T00:00:01.000Z', 'device:a')],
    },
  },
  { op: 'tick' },
  // 另一台机器：cre_1 同版本但更晚（它赢），cre_2 同版本但更早（它输）
  {
    op: 'push',
    request: {
      writer: 'device:b',
      objects: [
        obj('cre_1', 1, '2026-02-01T00:00:05.000Z', 'device:b'),
        obj('cre_2', 1, '2026-02-01T00:00:00.500Z', 'device:b'),
      ],
    },
  },
  { op: 'tick' },
  // 版本更高：直接收
  {
    op: 'push',
    request: {
      writer: 'device:a',
      objects: [obj('cre_1', 3, '2026-02-01T00:00:09.000Z', 'device:a')],
    },
  },
  // 墓碑：正文不留
  {
    op: 'push',
    request: {
      writer: 'device:a',
      objects: [obj('cre_2', 2, '2026-02-01T00:00:10.000Z', 'device:a', { deleted: true })],
    },
  },
  { op: 'tick' },
  { op: 'pull', args: { cursor: '0', writer: 'device:a', limit: 1 } },
  { op: 'pull', args: { cursor: '0', writer: 'device:b' } },
  { op: 'pull', args: { cursor: '2', limit: 2 } },
  { op: 'pull', args: {} },
  { op: 'status' },
  { op: 'conflicts' },
  { op: 'resolve', input: { kind: 'creator', id: 'cre_1' } },
  { op: 'conflicts' },
  { op: 'status' },
  { op: 'export' },
  // 错误分支：码与那句人话都要一样
  { op: 'push', request: { writer: '', objects: [] } },
  {
    op: 'push',
    request: { writer: 'device:a', objects: [{ ...obj('x', 1, 'x', 'a'), kind: 'nope' as never }] },
  },
  {
    op: 'push',
    request: { writer: 'device:a', objects: [obj('bad_version', 0, '2026-02-01T00:00:00Z', 'a')] },
  },
  {
    op: 'push',
    request: { writer: 'device:a', objects: [obj('bad_time', 1, 'not a time', 'a')] },
  },
  { op: 'resolve', input: { kind: 'nope', id: 'x' } },
  {
    op: 'push',
    request: {
      writer: 'device:a',
      objects: Array.from({ length: 501 }, (_, i) =>
        obj(`bulk_${String(i)}`, 1, '2026-02-01T00:00:00Z', 'a'),
      ),
    },
  },
]

interface Side {
  run(step: Step): unknown
  subscribe(): Promise<unknown>
}

/** 回执里只留协议那一半：订阅那一格只比状态（周期计费的细节在别的测试里钉）。 */
function normalize(out: unknown): unknown {
  if (out === null || typeof out !== 'object') return out
  if (Array.isArray(out)) return out.map(normalize)
  const o = out as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === 'subscription' && v !== null && typeof v === 'object')
      next[k] = { status: (v as { status: string }).status }
    else next[k] = normalize(v)
  }
  return next
}

function errorOf(err: unknown): { error: string; message: string } {
  if (err instanceof KolCloudError || err instanceof StandInKolSyncError)
    return { error: err.code, message: err.message }
  throw err
}

function realSide(now: () => string, db: SqliteLike): Side {
  const wallet: SubscriptionWallet = {
    async charge(args) {
      return { ok: true, credits: args.credits }
    },
  }
  const service = new KolCloudService({ store: new KolCloudStore(db), wallet, now })
  return {
    subscribe: () => service.subscribe(PRINCIPAL),
    run(step) {
      try {
        switch (step.op) {
          case 'push':
            return service.push(PRINCIPAL, step.request)
          case 'pull':
            return service.pull(PRINCIPAL, step.args)
          case 'status':
            return service.status(PRINCIPAL)
          case 'conflicts':
            return service.conflicts(PRINCIPAL)
          case 'resolve':
            return service.resolveConflicts(PRINCIPAL, step.input)
          case 'export':
            return service.exportAll(PRINCIPAL)
          default:
            return undefined
        }
      } catch (err) {
        return errorOf(err)
      }
    },
  }
}

function standInSide(now: () => string): Side {
  const service = new KolSyncStandIn({ now, org_id: PRINCIPAL.org_id })
  return {
    subscribe: async () => service.subscribe(),
    run(step) {
      try {
        switch (step.op) {
          case 'push':
            return service.push(step.request)
          case 'pull':
            return service.pull(step.args)
          case 'status':
            return service.status()
          case 'conflicts':
            return service.conflicts()
          case 'resolve':
            return service.resolveConflicts(step.input)
          case 'export':
            return service.exportAll()
          default:
            return undefined
        }
      } catch (err) {
        return errorOf(err)
      }
    },
  }
}

describe('WP165 同步协议：契约替身与真服务逐条一致', () => {
  it('没开通：两边都拦（402 那一码、同一句人话）', () => {
    const now = () => '2026-02-01T00:00:00.000Z'
    const real = realSide(now, new Database(':memory:') as unknown as SqliteLike)
    const fake = standInSide(now)
    const step: Step = { op: 'push', request: { writer: 'device:a', objects: [] } }
    expect(fake.run(step)).toEqual(real.run(step))
    expect(real.run(step)).toMatchObject({ error: 'payment_required' })
  })

  it('同一串动作：回执逐条一样', async () => {
    let t = Date.parse('2026-02-01T00:01:00.000Z')
    const now = () => new Date(t).toISOString()
    const db = new Database(':memory:')
    const real = realSide(now, db as unknown as SqliteLike)
    const fake = standInSide(now)
    await real.subscribe()
    await fake.subscribe()
    SCRIPT.forEach((step, i) => {
      if (step.op === 'tick') {
        t += 1000
        return
      }
      const want = normalize(real.run(step))
      const got = normalize(fake.run(step))
      expect(got, `第 ${String(i)} 步（${step.op}）`).toEqual(want)
    })
    // 这串动作真的走到了各个分支（不是一路报错、两边「一样地什么都没做」）
    const exported = real.run({ op: 'export' }) as {
      objects: KolSyncObject[]
      conflicts: unknown[]
    }
    expect(exported.objects.map((o) => o.id).sort()).toEqual(['cre_1', 'cre_2', 'ctc_1'])
    expect(exported.conflicts).toHaveLength(2)
    // 只属于云端的那一条：库里存的是可读的正文 JSON（以前在 apps/server 那边查）
    const row = db.prepare('SELECT body FROM kol_cloud_objects WHERE id = ?').get('ctc_1') as {
      body: string
    }
    expect(JSON.parse(row.body)).toEqual({ id: 'ctc_1', value_ref: 'kol_email:cre_1' })
    const tomb = db
      .prepare('SELECT body, deleted FROM kol_cloud_objects WHERE id = ?')
      .get('cre_2') as { body: string | null; deleted: number }
    expect(tomb).toEqual({ body: null, deleted: 1 })
  })
})
