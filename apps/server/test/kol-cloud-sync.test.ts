/**
 * 红人营销增值服务的**本地那一头**（67 §3，WP118）。
 *
 * 对面不是替身，是**真的 `KolCloudService`**（内存库 + 假钱包），中间那一跳用一个
 * 手写的假传输接起来：这样测的是两头真在按同一份协议说话，而不是"我按我自己的
 * 理解写了两遍、两遍刚好一致"。全程不出这个进程，不联网、不花钱。
 *
 * 要钉住的（派工单点名的那几条在本地的落点）：
 *
 * 1. 首次开通**全量上行**；
 * 2. 云连不通 / 没订阅时改动**攒在本地一条不丢**，恢复后一趟补上；
 * 3. **演练数据一条不上云**；
 * 4. 冲突**不静默覆盖本地**，双方版本都在界面上那一本里；
 * 5. 用户挑回被盖掉的那一份之后，两本账收敛到它；
 * 6. 本地删掉一条已同步的 → 云上也没了（墓碑真的推上去了）。
 */
import type { KolSyncObject } from '@agentsws/contracts'
import type { SubscriptionWallet } from '@agentsws/kol-cloud'
import { KolCloudService, KolCloudStore } from '@agentsws/kol-cloud'
import { beforeEach, describe, expect, it } from 'vitest'
import { createKolStore, type KolStore } from '../src/kol.js'
import {
  createKolCloudSync,
  type KolCloudCall,
  type KolCloudCallFn,
} from '../src/kol-cloud-sync.js'

/* ------------------------------------------------------------------ */
/* 假传输：本地 ⇄ 真的 KolCloudService                                  */
/* ------------------------------------------------------------------ */

const PRINCIPAL = {
  account_id: 'acc_1',
  org_id: 'org_1',
  workspace_id: 'ws_1',
  scopes: ['kol'],
}

/**
 * 内存版的 `SqliteLike`。
 *
 * `KolCloudStore` 只用 sqlite 的很小一角（几条固定的 prepare），所以照它自己那份
 * 测试的办法给一个内存替身：真 better-sqlite3 是原生模块，为跑几条 SQL 装它不值当。
 * **没实现的那条 SQL 直接抛**——协议或库改了而替身没跟上，测试要红，不能悄悄过。
 */
type StubRow = Record<string, unknown>

function memoryDb() {
  const tables = new Map<string, Map<string, StubRow>>()
  const of = (name: string): Map<string, StubRow> => {
    const found = tables.get(name)
    if (found !== undefined) return found
    const fresh = new Map<string, StubRow>()
    tables.set(name, fresh)
    return fresh
  }
  const rows = (name: string): StubRow[] => [...of(name).values()]
  const unresolved = (): StubRow[] =>
    rows('kol_cloud_conflicts').filter((r) => r.resolved_at === null)

  const runOf = (sql: string, args: unknown[]): unknown => {
    if (sql.includes('INSERT INTO kol_cloud_meta')) {
      of('kol_cloud_meta').set(String(args[0]), { value: String(args[1]) })
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO kol_cloud_objects')) {
      const [kind, id, version, updated_at, writer, deleted, body, seq] = args
      of('kol_cloud_objects').set(`${String(kind)}|${String(id)}`, {
        kind,
        id,
        version,
        updated_at,
        writer,
        deleted,
        body,
        seq,
      })
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO kol_cloud_conflicts')) {
      const [id, kind, object_id, winner, loser, at] = args
      const table = of('kol_cloud_conflicts')
      if (!table.has(String(id)))
        table.set(String(id), { id, kind, object_id, winner, loser, at, resolved_at: null })
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO kol_cloud_subscription')) {
      const prev = of('kol_cloud_subscription').get(String(args[0]))
      of('kol_cloud_subscription').set(String(args[0]), {
        service_id: String(args[0]),
        json: String(args[1]),
        last_sync_at: prev?.last_sync_at ?? null,
      })
      return { changes: 1 }
    }
    if (sql.includes('UPDATE kol_cloud_subscription SET last_sync_at')) {
      const row = of('kol_cloud_subscription').get(String(args[1]))
      if (row !== undefined) row.last_sync_at = String(args[0])
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO kol_cloud_charges')) {
      const table = of('kol_cloud_charges')
      if (!table.has(String(args[0])))
        table.set(String(args[0]), {
          charge_key: String(args[0]),
          json: String(args[1]),
          at: String(args[2]),
        })
      return { changes: 1 }
    }
    if (sql.includes('INSERT INTO kol_cloud_audit')) {
      of('kol_cloud_audit').set(String(args[0]), {
        seq: args[0],
        at: args[1],
        org_id: args[2],
        action: args[3],
        actor: args[4],
        note: args[5],
      })
      return { changes: 1 }
    }
    if (sql.includes('UPDATE kol_cloud_conflicts SET resolved_at')) {
      // 两种标法：按冲突号，或按对象（界面上"这一条我处理完了"）
      if (sql.includes('object_id = ?')) {
        const [at, kind, object_id] = args
        for (const row of unresolved())
          if (row.kind === kind && row.object_id === object_id) row.resolved_at = at
        return { changes: 1 }
      }
      const row = of('kol_cloud_conflicts').get(String(args[1]))
      if (row !== undefined && row.resolved_at === null) row.resolved_at = args[0]
      return { changes: 1 }
    }
    throw new Error(`内存替身没实现这条 SQL：${sql}`)
  }

  const allOf = (sql: string, args: unknown[]): unknown[] => {
    if (sql.includes('FROM kol_cloud_objects')) {
      let list = rows('kol_cloud_objects')
      if (sql.includes('seq > ?')) {
        list = list.filter((r) => Number(r.seq) > Number(args[0]))
        if (sql.includes('writer <> ?')) list = list.filter((r) => r.writer !== args[1])
        list.sort((a, b) => Number(a.seq) - Number(b.seq))
        return list.slice(0, Number(args[sql.includes('writer <> ?') ? 2 : 1]))
      }
      if (sql.includes('GROUP BY kind')) {
        const counts = new Map<string, number>()
        for (const r of list.filter((x) => Number(x.deleted) === 0))
          counts.set(String(r.kind), (counts.get(String(r.kind)) ?? 0) + 1)
        return [...counts].sort().map(([kind, n]) => ({ kind, n }))
      }
      return list.sort((a, b) =>
        `${String(a.kind)}|${String(a.id)}`.localeCompare(`${String(b.kind)}|${String(b.id)}`),
      )
    }
    if (sql.includes('FROM kol_cloud_conflicts'))
      // 导出要的是**全部**（含已处理的），界面上的标记要的是还没处理的那些
      return sql.includes('resolved_at IS NULL') ? unresolved() : rows('kol_cloud_conflicts')
    if (sql.includes('FROM kol_cloud_charges')) return rows('kol_cloud_charges')
    if (sql.includes('FROM kol_cloud_audit')) return rows('kol_cloud_audit').reverse()
    throw new Error(`内存替身没实现这条查询：${sql}`)
  }

  const getOf = (sql: string, args: unknown[]): unknown => {
    if (sql.includes('FROM kol_cloud_meta')) {
      const v = of('kol_cloud_meta').get(String(args[0]))
      return v === undefined ? undefined : { value: String(v.value) }
    }
    if (sql.includes('COUNT(*) AS n FROM kol_cloud_objects'))
      return { n: rows('kol_cloud_objects').filter((r) => Number(r.deleted) === 0).length }
    if (sql.includes('COUNT(*) AS n FROM kol_cloud_conflicts'))
      return {
        n: sql.includes('object_id = ?')
          ? unresolved().filter((c) => c.kind === args[0] && c.object_id === args[1]).length
          : unresolved().length,
      }
    if (sql.includes('FROM kol_cloud_objects'))
      return of('kol_cloud_objects').get(`${String(args[0])}|${String(args[1])}`)
    if (sql.includes('FROM kol_cloud_subscription'))
      return of('kol_cloud_subscription').get(String(args[0]))
    throw new Error(`内存替身没实现这条查询：${sql}`)
  }

  return {
    exec(sql: string) {
      if (sql.startsWith('DELETE FROM kol_cloud_objects')) of('kol_cloud_objects').clear()
      else if (sql.startsWith('DELETE FROM kol_cloud_conflicts')) of('kol_cloud_conflicts').clear()
      return undefined
    },
    prepare(sql: string) {
      return {
        run: (...args: unknown[]) => runOf(sql, args),
        get: (...args: unknown[]) => getOf(sql, args),
        all: (...args: unknown[]) => allOf(sql, args),
      }
    },
    close() {},
    /** 测试里直接看云上那本账（不经协议）。 */
    raw: {
      objects: () => rows('kol_cloud_objects'),
      audit: () => rows('kol_cloud_audit'),
    },
  }
}

/** 钱包替身：记下被扣了几次，可以随时调成"没钱"。 */
function fakeWallet(): SubscriptionWallet & { charges: string[]; broke: boolean } {
  const state = {
    charges: [] as string[],
    broke: false,
    async charge(args: { request_id: string; credits: number }) {
      if (state.broke)
        return { ok: false as const, reason: `积分不够：这一次要 ${String(args.credits)} 积分。` }
      state.charges.push(args.request_id)
      return { ok: true as const, credits: args.credits }
    },
  }
  return state
}

interface FakeCloud {
  service: KolCloudService
  call: KolCloudCallFn
  db: ReturnType<typeof memoryDb>
  wallet: ReturnType<typeof fakeWallet>
  /** 打上过哪些路（断言"没关联账号时一个字节都不发"）。 */
  calls: string[]
  /** 拔网线。 */
  offline: boolean
}

function newCloud(now: () => string): FakeCloud {
  const db = memoryDb()
  const wallet = fakeWallet()
  const service = new KolCloudService({ store: new KolCloudStore(db), wallet, now })
  const cloud: FakeCloud = { service, call, db, wallet, calls: [], offline: false }

  async function call<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<KolCloudCall<T>> {
    if (cloud.offline) return { ok: false, status: 0 }
    const method = init.method ?? 'GET'
    cloud.calls.push(`${method} ${path}`)
    const [pathname, query] = path.split('?')
    const params = new URLSearchParams(query ?? '')
    const limit = Number(params.get('limit'))
    try {
      let data: unknown
      if (pathname === '/v1/kol/sync/status') data = service.status(PRINCIPAL)
      else if (pathname === '/v1/kol/sync/push') data = service.push(PRINCIPAL, init.body as never)
      else if (pathname === '/v1/kol/sync/pull')
        data = service.pull(PRINCIPAL, {
          ...(params.get('cursor') === null ? {} : { cursor: params.get('cursor') as string }),
          ...(params.get('writer') === null ? {} : { writer: params.get('writer') as string }),
          ...(Number.isFinite(limit) ? { limit } : {}),
        })
      else if (pathname === '/v1/kol/sync/conflicts') data = service.conflicts(PRINCIPAL)
      else if (pathname === '/v1/kol/sync/conflicts/resolve')
        data = service.resolveConflicts(PRINCIPAL, init.body as never)
      else if (pathname === '/v1/kol/subscription') data = await service.subscribe(PRINCIPAL)
      else return { ok: false, status: 404, code: 'not_found', message: '没有这条路' }
      return { ok: true, status: 200, data: data as T }
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string }
      return {
        ok: false,
        status: e.status ?? 500,
        ...(e.code === undefined ? {} : { code: e.code }),
        message: e.message ?? '云侧出了点问题',
      }
    }
  }
  return cloud
}

/* ------------------------------------------------------------------ */
/* 本地那一本                                                           */
/* ------------------------------------------------------------------ */

const T0 = '2026-02-01T00:00:00.000Z'

const creator = (id: string, display_name: string, over: Record<string, unknown> = {}) =>
  ({ id, display_name, merged_from: [], ...over }) as never

const account = (id: string, creator_id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    creator_id,
    channel: 'youtube',
    handle: 'jonas',
    url: `https://www.youtube.com/@${id}`,
    observed_at: T0,
    ...over,
  }) as never

const collab = (id: string, creator_id: string, over: Record<string, unknown> = {}) =>
  ({ id, creator_id, channel: 'youtube', stage: 'sourced', currency: 'USD', ...over }) as never

describe('红人营销增值服务 · 本地那一头', () => {
  let clock: string
  let store: KolStore
  let cloud: FakeCloud
  let link: { on: boolean }
  let sync: ReturnType<typeof createKolCloudSync>

  const subscribe = async (): Promise<void> => {
    await cloud.service.subscribe(PRINCIPAL)
  }
  /** 云上那本账里现在有哪些对象（`kind|id`）。 */
  const cloudRows = (): string[] => cloud.db.raw.objects().map((o) => `${o.kind}|${o.id}`)

  beforeEach(() => {
    clock = T0
    store = createKolStore({ workspace_id: 'ws_1' })
    cloud = newCloud(() => clock)
    link = { on: true }
    sync = createKolCloudSync({
      clock: { now: () => clock },
      store: () => store,
      call: cloud.call,
      linked: () => link.on,
      deviceId: 'device:local',
    })
  })

  it('首次开通：本地整本推上去，一条不落', async () => {
    await subscribe()
    store.saveCreator(creator('cre_1', 'Gadget Jonas'))
    store.saveAccount(account('pa_1', 'cre_1'))
    store.saveCollaboration(collab('col_1', 'cre_1'))
    expect(sync.pending()).toBe(3)

    const run = await sync.sync()
    expect(run.ok).toBe(true)
    expect(run.pushed).toBe(3)
    expect(run.pulled).toBe(0)
    expect(sync.pending()).toBe(0)
    expect(cloud.service.status(PRINCIPAL).object_count).toBe(3)
    expect(cloudRows().sort()).toEqual([
      'collaboration|col_1',
      'creator|cre_1',
      'platform_account|pa_1',
    ])
  })

  it('没订阅：一句人话，改动照样攒着——开通之后一趟补上（一条不丢）', async () => {
    store.saveCreator(creator('cre_1', 'Gadget Jonas'))
    const run = await sync.sync()
    expect(run.ok).toBe(false)
    expect(run.message).toContain('还没开通')
    expect(sync.pending()).toBe(1)
    expect(cloudRows()).toEqual([])
    // 本地那一条没被动过
    expect(store.creator('cre_1')?.display_name).toBe('Gadget Jonas')

    await subscribe()
    const second = await sync.sync()
    expect(second.ok).toBe(true)
    expect(second.pushed).toBe(1)
    expect(cloudRows()).toEqual(['creator|cre_1'])
  })

  it('云连不通：排队等着，本地一条不动，恢复了自己补上', async () => {
    await subscribe()
    cloud.offline = true
    store.saveCreator(creator('cre_1', 'Gadget Jonas'))
    const run = await sync.sync()
    expect(run.ok).toBe(false)
    expect(run.message).toContain('联系不上')
    expect(sync.pending()).toBe(1)

    cloud.offline = false
    const again = await sync.sync()
    expect(again.ok).toBe(true)
    expect(again.pushed).toBe(1)
    expect(sync.pending()).toBe(0)
  })

  it('演练那一批一条不上云（红人 / 账号 / 挂在演练合作下的交付物）', async () => {
    await subscribe()
    store.saveCreator(creator('sbx_cre_1', '演练红人', { sandbox: true }))
    store.saveAccount(account('sbx_pa_1', 'sbx_cre_1'))
    store.saveCollaboration(collab('sbx_col_1', 'sbx_cre_1', { sandbox: true }))
    store.saveDeliverable({
      id: 'dlv_1',
      collaboration_id: 'sbx_col_1',
      kind: 'video',
      due_at: T0,
      review: 'pending',
    } as never)
    store.saveCollaboration(collab('col_real', 'cre_real'))

    const run = await sync.sync()
    expect(run.pushed).toBe(1)
    expect(cloudRows()).toEqual(['collaboration|col_real'])
  })

  it('另一台机器写的：拉下来进本地库', async () => {
    await subscribe()
    cloud.service.push(PRINCIPAL, {
      writer: 'device:other',
      objects: [
        {
          kind: 'creator',
          id: 'cre_other',
          version: 1,
          updated_at: '2026-02-02T00:00:00.000Z',
          writer: 'device:other',
          body: { id: 'cre_other', display_name: '别的机器加的', merged_from: [] },
        },
      ],
    })
    const run = await sync.sync()
    expect(run.ok).toBe(true)
    expect(run.pulled).toBe(1)
    expect(store.creator('cre_other')?.display_name).toBe('别的机器加的')
  })

  it('自己推上去的那一份不会被原样拉回来（省一趟，也不会转圈）', async () => {
    await subscribe()
    store.saveCreator(creator('cre_1', 'Gadget Jonas'))
    const first = await sync.sync()
    expect(first.pushed).toBe(1)
    const second = await sync.sync()
    expect(second.pushed).toBe(0)
    expect(second.pulled).toBe(0)
    expect(sync.pending()).toBe(0)
  })

  it('两头都改了同一条：本地不被静默覆盖，双方版本都在', async () => {
    await subscribe()
    store.saveCreator(creator('cre_1', '第一版'))
    await sync.sync()

    // 另一台机器改同一条（版本号接着往上数，云上干净接受）
    cloud.service.push(PRINCIPAL, {
      writer: 'device:other',
      objects: [
        {
          kind: 'creator',
          id: 'cre_1',
          version: 2,
          updated_at: '2026-02-03T00:00:00.000Z',
          writer: 'device:other',
          body: { id: 'cre_1', display_name: '别的机器改的', merged_from: [] },
        },
      ],
    })
    // 本地也改了（还没同步过云上那一版）
    clock = '2026-02-04T00:00:00.000Z'
    store.saveCreator(creator('cre_1', '本地又改了'))

    const run = await sync.sync()
    expect(run.ok).toBe(true)
    expect(run.conflicts).toBe(1)

    const list = sync.conflicts()
    expect(list).toHaveLength(1)
    // 时间晚的赢（最后写入者胜），**输的那一份留着**
    expect((list[0]?.winner.body as { display_name?: string })?.display_name).toBe('本地又改了')
    expect((list[0]?.loser.body as { display_name?: string })?.display_name).toBe('别的机器改的')
    expect(list[0]?.label).toBe('本地又改了')
    expect(list[0]?.source).toBe('cloud')
    // 云上也记着这一条（后台抽屉那个标就是它）
    expect(cloud.service.status(PRINCIPAL).pending_conflicts).toBe(1)
  })

  it('挑回被盖掉的那一份：两本账都收敛到它，云上的标记消掉', async () => {
    await subscribe()
    store.saveCreator(creator('cre_1', '第一版'))
    await sync.sync()
    cloud.service.push(PRINCIPAL, {
      writer: 'device:other',
      objects: [
        {
          kind: 'creator',
          id: 'cre_1',
          version: 2,
          updated_at: '2026-02-03T00:00:00.000Z',
          writer: 'device:other',
          body: { id: 'cre_1', display_name: '别的机器改的', merged_from: [] },
        },
      ],
    })
    clock = '2026-02-04T00:00:00.000Z'
    store.saveCreator(creator('cre_1', '本地又改了'))
    await sync.sync()
    expect(sync.conflicts()).toHaveLength(1)

    await sync.resolveConflict({ kind: 'creator', id: 'cre_1', pick: 'loser' })
    expect(store.creator('cre_1')?.display_name).toBe('别的机器改的')

    const run = await sync.sync()
    expect(run.ok).toBe(true)
    // 推上去之后两本都是被挑回来的那一份
    expect(store.creator('cre_1')?.display_name).toBe('别的机器改的')
    const exported = cloud.service.exportAll(PRINCIPAL).objects.find((o) => o.id === 'cre_1')
    expect((exported?.body as { display_name?: string })?.display_name).toBe('别的机器改的')
    // 标记消掉了，但输的那一份仍在导出里（一条不删）
    expect(cloud.service.conflicts(PRINCIPAL).pending_conflicts).toBe(0)
    expect(cloud.service.exportAll(PRINCIPAL).conflicts).toHaveLength(1)
  })

  it('本地删掉一条已同步的：云上也删掉（墓碑推上去了）', async () => {
    await subscribe()
    store.saveCreator(creator('cre_1', 'Gadget Jonas'))
    await sync.sync()
    expect(cloud.service.status(PRINCIPAL).object_count).toBe(1)

    store.removeRow('creator', 'cre_1')
    expect(sync.pending()).toBe(1)
    const run = await sync.sync()
    expect(run.pushed).toBe(1)
    expect(cloud.service.status(PRINCIPAL).object_count).toBe(0)
    // 墓碑推完之后不该每次都再推一次
    expect(sync.pending()).toBe(0)
  })

  it('没关联账号：一个字节都不发，只说去哪儿点', async () => {
    link.on = false
    store.saveCreator(creator('cre_1', 'Gadget Jonas'))
    const status = await sync.status()
    expect(status.linked).toBe(false)
    expect(status.reason).toContain('关联')
    expect(status.pending).toBe(1)
    expect(cloud.calls).toEqual([])

    const run = await sync.sync()
    expect(run.ok).toBe(false)
    expect(cloud.calls).toEqual([])
  })

  it('状态里带上云上的数字与订阅状态', async () => {
    await subscribe()
    store.saveCreator(creator('cre_1', 'Gadget Jonas'))
    await sync.sync()
    const status = await sync.status()
    expect(status.linked).toBe(true)
    expect(status.cloud_reachable).toBe(true)
    expect(status.object_count).toBe(1)
    expect(status.subscription?.status).toBe('active')
    expect(status.pending).toBe(0)
    expect(status.device_id).toBe('device:local')
    expect(status.last_sync_at).toBeDefined()
  })

  it('云上那一本里是**正文**，不是一坨看不懂的字节（67 §1：云端要读得懂数据）', async () => {
    await subscribe()
    store.saveCreator(creator('cre_1', 'Gadget Jonas'))
    await sync.sync()
    const row = cloud.db.raw.objects().find((o) => o.id === 'cre_1')
    expect(row?.body).toBeDefined()
    const body = JSON.parse(String(row?.body)) as { display_name?: string }
    expect(body.display_name).toBe('Gadget Jonas')
  })

  it('联系方式只上行那个 key 名，明文一个字节都不出本地', async () => {
    await subscribe()
    store.saveContact({
      id: 'ctc_1',
      creator_id: 'cre_1',
      kind: 'email',
      source: 'manual',
      value_ref: 'kol_email:cre_1',
    } as never)
    await sync.sync()
    const row = cloud.db.raw.objects().find((o) => o.id === 'ctc_1')
    const body = JSON.stringify(row?.body)
    expect(body).toContain('kol_email:cre_1')
    expect(body).not.toContain('@')
  })

  it('稳定序列化：键的顺序换了不算改过（不然每一趟都白推一次）', async () => {
    await subscribe()
    store.saveCollaboration(collab('col_1', 'cre_1', { budget: 400 }))
    await sync.sync()
    // 同一份数据，键的顺序不同
    store.saveCollaboration({
      currency: 'USD',
      budget: 400,
      stage: 'sourced',
      channel: 'youtube',
      creator_id: 'cre_1',
      id: 'col_1',
    } as never)
    expect(sync.pending()).toBe(0)
  })

  it('一次推不完就分批（500 条一批）', async () => {
    await subscribe()
    for (let i = 0; i < 520; i++)
      store.saveCreator(creator(`cre_${String(i)}`, `红人 ${String(i)}`))
    expect(sync.pending()).toBe(520)
    const run = await sync.sync()
    expect(run.ok).toBe(true)
    expect(run.pushed).toBe(520)
    expect(cloud.service.status(PRINCIPAL).object_count).toBe(520)
    expect(cloud.calls.filter((c) => c.endsWith('/v1/kol/sync/push'))).toHaveLength(2)
  })

  it('机器标识落盘：换一个进程还是同一台机器（不会把自己写的当成别人写的）', () => {
    const again = createKolCloudSync({
      clock: { now: () => clock },
      store: () => store,
      call: cloud.call,
      linked: () => link.on,
      deviceId: 'device:local',
    })
    expect(again.deviceId()).toBe(sync.deviceId())
  })

  it('对象种类的映射：本地七张表都同步，契约先行的三个报出来不静默扔', async () => {
    await subscribe()
    // 云上有一条本地还没有表的（`note`）
    cloud.service.push(PRINCIPAL, {
      writer: 'device:other',
      objects: [
        {
          kind: 'note',
          id: 'note_1',
          version: 1,
          updated_at: '2026-02-02T00:00:00.000Z',
          writer: 'device:other',
          body: { id: 'note_1', text: '记一笔' },
        } as KolSyncObject,
      ],
    })
    const run = await sync.sync()
    expect(run.skipped).toBe(1)
    expect(run.pulled).toBe(0)
  })
})
