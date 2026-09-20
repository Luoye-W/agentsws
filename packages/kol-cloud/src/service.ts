/**
 * 红人营销增值服务的服务层（67 §3）。
 *
 * 三件事，边界刻意分得很死：
 *
 * 1. **订阅**（开通 / 续费 / 取消 / 赠送）——机制全在 `@agentsws/metering` 的通用
 *    订阅引擎里，这里只负责"把库里那一行读出来、把钱那一跳打出去、把结果写回去"；
 * 2. **同步闸门**——没订阅 / 欠费一律 402，**一条数据都不动**；
 * 3. **双向同步**（push / pull）——最后写入者胜，输的那一份留着。
 *
 * 为什么扣费不在同步那条路上做：同步一天可能跑几百次，每次都去算一遍 cycle 是
 * 白费；更要紧的是，**扣费失败不该让一次同步变成 500**。扣费只在两个时刻发生：
 * 用户点开通的那一刻（{@link KolCloudService.subscribe}），以及每个月的定时任务
 * （{@link KolCloudService.runBilling}，Workers 形态由 DO 的 alarm 叫醒）。
 */
import type {
  KolCloudDeleteResult,
  KolCloudExport,
  KolObjectKind,
  KolSyncConflict,
  KolSyncConflictList,
  KolSyncConflictResolveResult,
  KolSyncObject,
  KolSyncPullResult,
  KolSyncPushRequest,
  KolSyncPushResult,
  KolSyncStatus,
  ServiceSubscription,
  SubscriptionCharge,
  SubscriptionService,
} from '@agentsws/contracts'
import {
  emptySubscription,
  isKolObjectKind,
  KOL_SERVICE_ID,
  KOL_SYNC_MAX_BATCH,
  kolWinsOver,
  subscriptionUsable,
} from '@agentsws/contracts'
import {
  cancelSubscription,
  dueCharges,
  grantSubscriptionMonths,
  startSubscription,
  subscriptionPaid,
  subscriptionServiceById,
  subscriptionStatusAt,
  subscriptionUnpaid,
} from '@agentsws/metering'
import type { KolCloudSummary } from './admin-port.js'
import type { KolCloudStore } from './store.js'
import { KolCloudError, type KolCloudPrincipal, type SubscriptionWallet } from './types.js'

export interface KolCloudServiceOptions {
  store: KolCloudStore
  wallet: SubscriptionWallet
  now: () => string
  /** 哪个服务。默认红人那个；写成参数是为了让客服那个（WP124）直接复用这一层。 */
  service?: SubscriptionService
}

/** 没订阅 / 欠费时那一句话。**说清楚数据还在**——用户最怕的就是这个。 */
const gateMessage = (status: string): string => {
  if (status === 'grace')
    return '这个月的服务费没扣上（积分不够），云端同步先暂停了。你的红人数据一条都没动——充值后自动恢复，30 天内都算宽限期。'
  if (status === 'suspended')
    return '云端同步已经暂停（服务费欠着超过 30 天）。数据一条都没删：充值后随时恢复，也可以先把云端这份导出来。'
  return '还没开通「红人营销增值服务」。开通后本地与云端各存一份，换台电脑也能接着干（30 积分 / 月）。'
}

export class KolCloudService {
  readonly store: KolCloudStore
  private readonly wallet: SubscriptionWallet
  private readonly now: () => string
  private readonly service: SubscriptionService

  constructor(options: KolCloudServiceOptions) {
    this.store = options.store
    this.wallet = options.wallet
    this.now = options.now
    const found = options.service ?? subscriptionServiceById(KOL_SERVICE_ID)
    if (found === undefined)
      // 装配错误要吵：登记表里没有这个服务，等于这台机器上根本没有这块业务
      throw new Error(`subscriptions.json 里没有「${KOL_SERVICE_ID}」这个服务`)
    this.service = found
  }

  /* ---------------- 订阅 ---------------- */

  /** 库里那一行（没有就给一个 `none` 的空壳——界面上那张卡总要有东西渲染）。 */
  subscription(org_id: string): ServiceSubscription {
    return (
      this.store.subscription(this.service.id) ??
      emptySubscription(org_id, this.service.id, this.now())
    )
  }

  /** **算过一遍**的状态（宽限期是靠时间过期的，没有谁会在那一刻跑来改库）。 */
  liveStatus(org_id: string): string {
    return subscriptionStatusAt(this.subscription(org_id), this.now())
  }

  /**
   * 开通（或者欠费之后充上钱回来）。**当场扣第一期**。
   *
   * 扣不上就如实说，并且**不把订阅留在 active**——那样用户会以为开通成功了，
   * 下一次同步才发现是 402。
   */
  async subscribe(principal: KolCloudPrincipal): Promise<ServiceSubscription> {
    if (!this.service.available)
      throw new KolCloudError(
        'invalid_input',
        `「${this.service.label_zh}」还没上线，暂时开通不了。`,
      )
    const at = this.now()
    const started = startSubscription(this.subscription(principal.org_id), at)
    this.store.putSubscription(started)
    this.store.appendAudit({
      at,
      org_id: principal.org_id,
      action: 'subscribe',
      actor: `ws:${principal.workspace_id}`,
    })
    await this.runBilling(principal)
    return this.subscription(principal.org_id)
  }

  /** 取消：当期用完为止。不立刻断、不退款、不删数据。 */
  cancel(principal: KolCloudPrincipal): ServiceSubscription {
    const at = this.now()
    const next = cancelSubscription(this.subscription(principal.org_id), at)
    this.store.putSubscription(next)
    this.store.appendAudit({
      at,
      org_id: principal.org_id,
      action: 'cancel',
      actor: `ws:${principal.workspace_id}`,
      note: '当期用完为止',
    })
    return next
  }

  /** 运营后台赠送 N 个月（那几期 0 积分，照样走一遍流程）。 */
  grantMonths(org_id: string, months: number): ServiceSubscription {
    const at = this.now()
    const next = grantSubscriptionMonths(this.subscription(org_id), months, at)
    this.store.putSubscription(next)
    this.store.appendAudit({
      at,
      org_id,
      action: 'grant',
      actor: 'admin',
      note: `赠送 ${String(months)} 个月`,
    })
    return next
  }

  /**
   * 把**到点该扣的那几期**扣掉。
   *
   * 定时任务与"用户点开通"跑的是同一个函数。重跑十遍也只扣一次：幂等键里没有
   * 时间戳，而且库里那张表的主键就是它。
   *
   * 一期扣不上就**停在那里**（进宽限），后面几期不再试——用户这会儿没钱，
   * 连着扣三期只会把账搞乱。
   */
  async runBilling(principal: {
    org_id: string
    workspace_id: string
  }): Promise<SubscriptionCharge[]> {
    const out: SubscriptionCharge[] = []
    const sub = this.subscription(principal.org_id)
    const charges = dueCharges({
      sub,
      credits_per_month: this.service.credits_per_month,
      now: this.now(),
      charged: this.store.chargedKeys(),
    })
    let current = sub
    for (const charge of charges) {
      const at = this.now()
      const outcome =
        charge.credits === 0
          ? ({ ok: true, credits: 0 } as const)
          : await this.wallet.charge({
              org_id: principal.org_id,
              workspace_id: principal.workspace_id,
              capability: this.service.id,
              credits: charge.credits,
              request_id: charge.charge_key,
            })
      if (outcome.ok) {
        current = subscriptionPaid(current, charge, at)
        const row: SubscriptionCharge = {
          org_id: principal.org_id,
          service_id: this.service.id,
          cycle_start: charge.cycle_start,
          cycle_end: charge.cycle_end,
          charge_key: charge.charge_key,
          credits: charge.credits,
          granted: charge.granted,
          status: 'paid',
          at,
        }
        this.store.putCharge(row)
        this.store.putSubscription(current)
        out.push(row)
        continue
      }
      // 扣不上：进宽限，**这一期不记进 charges 表**（没扣成就不算扣过，
      // 否则充值回来之后这一期就被永远跳过了——用户白付一个月）
      current = subscriptionUnpaid(current, charge, at)
      this.store.putSubscription(current)
      this.store.appendAudit({
        at,
        org_id: principal.org_id,
        action: 'charge_failed',
        actor: 'system',
        note: outcome.reason,
      })
      out.push({
        org_id: principal.org_id,
        service_id: this.service.id,
        cycle_start: charge.cycle_start,
        cycle_end: charge.cycle_end,
        charge_key: charge.charge_key,
        credits: charge.credits,
        granted: charge.granted,
        status: 'failed',
        reason: outcome.reason,
        at,
      })
      break
    }
    return out
  }

  /**
   * 后台抽屉那一块（订阅状态、云端对象数、最近同步、最近几笔扣费）。
   *
   * 状态**算过一遍**再给：后台看到的"还在宽限里"必须与用户那一侧看到的是同一句话。
   */
  summary(org_id: string): KolCloudSummary {
    const sub = this.subscription(org_id)
    const last = this.store.lastSyncAt(this.service.id)
    return {
      org_id,
      subscription: { ...sub, status: subscriptionStatusAt(sub, this.now()) },
      object_count: this.store.count(),
      pending_conflicts: this.store.openConflictCount(),
      ...(last === undefined ? {} : { last_sync_at: last }),
      charges: this.store.charges(12),
    }
  }

  /* ---------------- 闸门 ---------------- */

  /**
   * 同步能不能做。不能就抛 402 **一句人话**。
   *
   * 402 而不是 403：403 是"你没权限"，而这里是"这一项要付费"——两句话在界面上
   * 该长得完全不一样（一个给"去充值"，一个给"找管理员"）。
   */
  private gate(org_id: string): void {
    const status = subscriptionStatusAt(this.subscription(org_id), this.now())
    if (subscriptionUsable(status)) return
    throw new KolCloudError('payment_required', gateMessage(status), {
      details: { status, service_id: this.service.id },
    })
  }

  /* ---------------- 同步 ---------------- */

  /**
   * 上行：本地把改过的那些推上来。
   *
   * 判"是不是冲突"靠**版本号**，不靠时间：
   *
   * - `candidate.version > current.version` → 本地是在看过云端当前值之后改的，
   *   干净覆盖；
   * - `candidate.version <= current.version` → 两头各改各的（本地没看过云端那一版），
   *   这才是冲突。按最后写入者胜定当前值，**输的那一份留下来**。
   *
   * 用时间判的话，两台机器的钟差几秒就会把一次正常更新当成冲突，界面上天天挂标记。
   */
  push(principal: KolCloudPrincipal, request: KolSyncPushRequest): KolSyncPushResult {
    this.gate(principal.org_id)
    const writer = (request.writer ?? '').trim()
    if (writer === '')
      throw new KolCloudError('invalid_input', '这次同步没带机器标识（writer），没法判谁写的。')
    const objects = request.objects ?? []
    if (objects.length > KOL_SYNC_MAX_BATCH)
      throw new KolCloudError(
        'invalid_input',
        `一次最多推 ${String(KOL_SYNC_MAX_BATCH)} 条，这次 ${String(objects.length)} 条。分几批再试。`,
      )
    const at = this.now()
    const rejected: KolSyncObject[] = []
    const conflicts: KolSyncConflict[] = []
    let accepted = 0
    for (const raw of objects) {
      const candidate = this.validate(raw)
      const current = this.store.object(candidate.kind, candidate.id)
      if (current === undefined) {
        this.store.put(candidate)
        accepted += 1
        continue
      }
      // 一模一样：反复推同一条不该每次都算一次冲突，也不该白写一次库
      if (
        current.version === candidate.version &&
        current.updated_at === candidate.updated_at &&
        current.writer === candidate.writer
      )
        continue
      if (candidate.version > current.version) {
        this.store.put(candidate)
        accepted += 1
        continue
      }
      // 两头各改各的
      const candidateWins = kolWinsOver(candidate, current)
      const winner = candidateWins ? candidate : current
      const loser = candidateWins ? current : candidate
      const conflict: KolSyncConflict = {
        kind: candidate.kind,
        id: candidate.id,
        winner,
        loser,
        at,
      }
      // 冲突 id 由内容推出来：同一批重放不会记出两条
      this.store.putConflict(`cfl_${candidate.kind}_${candidate.id}_${loser.updated_at}`, conflict)
      conflicts.push(conflict)
      if (candidateWins) {
        // 赢的那一份要**接着云端的版本号往上数**，否则下一次推同一条又会被判成冲突
        this.store.put({ ...candidate, version: current.version + 1 })
        accepted += 1
        rejected.push(this.store.object(candidate.kind, candidate.id) as KolSyncObject)
      } else {
        rejected.push(current)
      }
    }
    this.store.touchSync(this.service.id, at)
    return { accepted, rejected, conflicts, cursor: String(this.store.cursor()), at }
  }

  /** 下行：游标之后云端改过的那些。自己刚推上来的那些不回给自己（省一趟）。 */
  pull(
    principal: KolCloudPrincipal,
    args: { cursor?: string; writer?: string; limit?: number },
  ): KolSyncPullResult {
    this.gate(principal.org_id)
    const from = Number(args.cursor ?? '0')
    const cursor = Number.isFinite(from) && from > 0 ? from : 0
    const limit = Math.min(Math.max(1, args.limit ?? KOL_SYNC_MAX_BATCH), KOL_SYNC_MAX_BATCH)
    const writer = args.writer?.trim()
    const rows = this.store.since(
      cursor,
      limit + 1,
      writer === undefined || writer === '' ? undefined : writer,
    )
    const has_more = rows.length > limit
    const page = has_more ? rows.slice(0, limit) : rows
    const at = this.now()
    this.store.touchSync(this.service.id, at)
    /*
     * 这一页空了就把游标推到**云端当前**：否则本地会永远停在一个旧游标上，每次
     * 都拉一遍同样的空页（云端最新的那几条是它自己写的，被上面按 writer 滤掉了）。
     * 还有下一页的时候**不能**这么推——那会把后面几页整片跳过去。
     */
    const last = page[page.length - 1]
    const next = last === undefined && !has_more ? this.store.cursor() : (last?.seq ?? cursor)
    return { objects: page.map((r) => r.object), cursor: String(next), has_more, at }
  }

  /** 界面上那一行：订阅状态 + 云端多少条 + 最近同步 + 有没有没处理的冲突。 */
  status(principal: KolCloudPrincipal): KolSyncStatus {
    const at = this.now()
    const sub = this.subscription(principal.org_id)
    const last = this.store.lastSyncAt(this.service.id)
    return {
      org_id: principal.org_id,
      subscription: { ...sub, status: subscriptionStatusAt(sub, at) },
      object_count: this.store.count(),
      by_kind: this.store.countByKind(),
      cursor: String(this.store.cursor()),
      pending_conflicts: this.store.openConflictCount(),
      ...(last === undefined ? {} : { last_sync_at: last }),
      at,
    }
  }

  /**
   * 还没处理的冲突（界面上要标出来的那几条，**双方版本都带着**）。
   *
   * 一样过闸门：没订阅不给读。理由是这一条路由回的是数据本身（两份正文），
   * 不是"有几条"那个数——数在 {@link KolCloudService.status} 里，那一条不拦。
   */
  conflicts(principal: KolCloudPrincipal, limit?: number): KolSyncConflictList {
    this.gate(principal.org_id)
    const at = this.now()
    return {
      org_id: principal.org_id,
      conflicts: this.store.openConflictEntries(limit ?? 200),
      pending_conflicts: this.store.openConflictCount(),
      at,
    }
  }

  /**
   * 用户在界面上处理完一条：把云上这一本里那个对象的冲突标掉。
   *
   * **只是标掉，不删任何一份**——输的那一份还在账上（导出时也一起带走），
   * 标掉的只是"这条还等着人看"这件事。挑回被盖掉的那一份是本地那一头做的
   * （写进本地库，下一趟推上来），云上这一跳只负责把标记消掉。
   */
  resolveConflicts(
    principal: KolCloudPrincipal,
    input: { kind: string; id: string },
  ): KolSyncConflictResolveResult {
    this.gate(principal.org_id)
    const kind = input.kind
    if (!isKolObjectKind(kind))
      throw new KolCloudError('invalid_input', '这个对象种类不认识（kind 不在清单里）。')
    const id = (input.id ?? '').trim()
    if (id === '') throw new KolCloudError('invalid_input', '没说要处理哪一条（缺 id）。')
    const at = this.now()
    const resolved = this.store.resolveConflictsForObject(kind, id, at)
    this.store.appendAudit({
      at,
      org_id: principal.org_id,
      action: 'sync',
      actor: `ws:${principal.workspace_id}`,
      note: `冲突已处理：${kind} ${String(resolved)} 条`,
    })
    return {
      org_id: principal.org_id,
      kind: kind as KolObjectKind,
      id,
      resolved,
      pending_conflicts: this.store.openConflictCount(),
      at,
    }
  }

  /* ---------------- 用户的数据权利（49 §5 / 21 §4） ---------------- */

  /**
   * 导出云端这一份。**没订阅也给导**——欠费之后最该做的事就是把数据拿走，
   * 这时候拦着他等于拿数据当人质。
   */
  exportAll(principal: KolCloudPrincipal): KolCloudExport {
    const at = this.now()
    this.store.appendAudit({
      at,
      org_id: principal.org_id,
      action: 'export',
      actor: `ws:${principal.workspace_id}`,
    })
    return {
      format: 1,
      org_id: principal.org_id,
      at,
      subscription: this.subscription(principal.org_id),
      objects: this.store.all(),
      // 留着的那些冲突版本也一起带走（不然"输的那一份"就真丢了）。
      // **含已处理的**：用户点过"这一条我处理完了"不等于同意把那一份扔掉。
      conflicts: this.store.allConflicts(KOL_SYNC_MAX_BATCH),
    }
  }

  /** 删掉云端这一份。**本地一条不动**——这是两份数据，不是一份。 */
  deleteAll(principal: KolCloudPrincipal): KolCloudDeleteResult {
    const at = this.now()
    const deleted = this.store.clearObjects()
    this.store.appendAudit({
      at,
      org_id: principal.org_id,
      action: 'delete',
      actor: `ws:${principal.workspace_id}`,
      note: `云端 ${String(deleted)} 条`,
    })
    return { org_id: principal.org_id, deleted, subscription_kept: true, at }
  }

  /* ---------------- 校验 ---------------- */

  private validate(raw: KolSyncObject): KolSyncObject {
    if (raw === null || typeof raw !== 'object')
      throw new KolCloudError('invalid_input', '同步里有一条不是对象。')
    if (!isKolObjectKind(String(raw.kind)))
      throw new KolCloudError('invalid_input', `认不出这种数据：${String(raw.kind)}`)
    if (typeof raw.id !== 'string' || raw.id.trim() === '')
      throw new KolCloudError('invalid_input', '同步里有一条没有 id。')
    if (!Number.isInteger(raw.version) || raw.version < 1)
      throw new KolCloudError('invalid_input', '版本号要是 1 以上的整数（每对象自己数）。')
    if (typeof raw.updated_at !== 'string' || Number.isNaN(Date.parse(raw.updated_at)))
      throw new KolCloudError('invalid_input', '同步里有一条的时间不合法。')
    if (typeof raw.writer !== 'string' || raw.writer.trim() === '')
      throw new KolCloudError('invalid_input', '同步里有一条没带机器标识。')
    const deleted = raw.deleted === true
    const base: KolSyncObject = {
      kind: raw.kind,
      id: raw.id,
      version: raw.version,
      updated_at: raw.updated_at,
      writer: raw.writer,
    }
    if (deleted) return { ...base, deleted: true }
    return raw.body === undefined ? base : { ...base, body: raw.body }
  }
}
