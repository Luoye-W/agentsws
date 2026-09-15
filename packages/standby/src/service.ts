/**
 * 值守这件事的全貌（49 §6 WP60）：**订阅 + 进程 + 搬家**三件事在这里合成一个对象。
 *
 * 订阅那一半照 12 §4 的混合计费：钱包做结算层，订阅只是一种计价方式。
 * 所以这里没有第二本账——开通就是一次 `reserve → settle`，价从 `pricing.json`
 * 的 `standby.seat.month` 来，账落在 `org_id` 上（52 O3）。
 *
 * 四条纪律：
 *
 * 1. **余额不足只拒这一次**（与 22 §3 / 钱包同一条）：402 + 一句人话，不冻结、不拉黑。
 * 2. **到期即停，但不删数据**（41 §2.3）：`expired` 的工作区导出照常——
 *    "随时搬家"这条纪律如果在到期那天失效，那它就不是纪律，是促销话术。
 * 3. **上传的包先校验再解包**（WP36 的 manifest + 每文件 sha256 + zip crc）。
 *    校验不过：临时文件删掉，租户目录**一个字节都不动**。
 * 4. **导入只往空目录导**：已经有数据的工作区要重新导入，得先停、再显式覆盖——
 *    默认行为不该是"把这个租户现在的数据盖掉"。
 */
import type {
  Iso8601,
  Pricing,
  StandbyEvent,
  StandbyWorkspace,
  WorkspaceId,
} from '@agentsws/contracts'
import { STANDBY_PERIOD_DAYS, STANDBY_RENEWAL_LEAD_DAYS, STANDBY_UNIT } from '@agentsws/contracts'
import {
  creditsFor,
  roundCredits,
  type Wallet,
  WalletError,
  type WalletReservation,
} from '@agentsws/metering'
import { ProcessPool } from './orchestrator.js'
import {
  assertWorkspaceId,
  type StandbyDeps,
  StandbyError,
  type StandbyRecord,
  shouldRun,
} from './types.js'

/** 值守订阅按这条能力计价。 */
export const STANDBY_CAPABILITY = 'standby.seat.month'

/** 一个工作区最多几个座位。不是技术上限，是"填错一个零"的上限。 */
export const MAX_SEATS = 500

const DAY_MS = 24 * 60 * 60 * 1000

export interface StandbyServiceDeps extends StandbyDeps {
  wallet: Wallet
  pricing: Pricing
  /** 计量事件里的请求号；不给就按时间 + 计数（这个包里不裸调 `Math.random()`）。 */
  newRequestId?: () => string
}

function plusDays(at: Iso8601, days: number): Iso8601 {
  return new Date(Date.parse(at) + days * DAY_MS).toISOString()
}

/** 契约那份视图（库里那几格编排自用的字段不端给调用方）。 */
export function toView(record: StandbyRecord): StandbyWorkspace {
  return {
    workspace_id: record.workspace_id,
    org_id: record.org_id,
    status: record.status,
    seats: record.seats,
    period_end: record.period_end,
    ...(record.port === undefined ? {} : { port: record.port }),
    ...(record.last_health_at === undefined ? {} : { last_health_at: record.last_health_at }),
  }
}

export class StandbyService {
  readonly pool: ProcessPool
  /** 打子进程用的那个 fetch（反向代理要它；测试注入假的）。 */
  readonly fetch: StandbyDeps['fetch']
  private readonly deps: StandbyServiceDeps
  private readonly nextRequestId: () => string

  constructor(deps: StandbyServiceDeps) {
    this.deps = deps
    this.fetch = deps.fetch
    this.pool = new ProcessPool(deps)
    let n = 0
    this.nextRequestId =
      deps.newRequestId ??
      (() => {
        n += 1
        return `standby_${deps.clock.now().replace(/\D/g, '').slice(0, 14)}_${String(n)}`
      })
  }

  private now(): Iso8601 {
    return this.deps.clock.now()
  }

  private emit(event: StandbyEvent): void {
    this.deps.onEvent?.(event)
  }

  /** 一个座位一个月多少积分（价目表里那条；表里没有就是装配错了，不要猜一个数）。 */
  seatPrice(): number {
    const price = creditsFor(this.deps.pricing, STANDBY_CAPABILITY, 1)
    if (price === undefined)
      throw new StandbyError('internal', `价目表里没有 ${STANDBY_CAPABILITY} 这一条`)
    return price
  }

  monthlyCredits(seats: number): number {
    return roundCredits(this.seatPrice() * seats)
  }

  list(org_id: string): StandbyWorkspace[] {
    return this.deps.store.list(org_id).map(toView)
  }

  get(workspace_id: WorkspaceId): StandbyWorkspace | undefined {
    const record = this.deps.store.get(assertWorkspaceId(workspace_id))
    return record === undefined ? undefined : toView(record)
  }

  /**
   * 收一个月的钱。
   *
   * `reserve → settle` 两步照做（不是直接扣）：与 `/v1/ai/*` 那条路同一套动作，
   * 于是余额、预扣中、计量事件三处看到的都是同一种形状的记录。
   */
  private chargeMonth(org_id: string, workspace_id: WorkspaceId, seats: number): void {
    const credits = this.monthlyCredits(seats)
    let reservation: WalletReservation
    try {
      reservation = this.deps.wallet.reserve({
        org_id,
        workspace_id,
        capability: STANDBY_CAPABILITY,
        unit: STANDBY_UNIT,
        quantity: seats,
        credits,
        request_id: this.nextRequestId(),
      })
    } catch (err) {
      if (err instanceof WalletError && err.code === 'insufficient_credits')
        throw new StandbyError(
          'insufficient_credits',
          `开一个月的值守要 ${String(credits)} 积分（${String(seats)} 个座位），余额不够。` +
            '去"设置 → 账号与积分"充值后再试——这一次没有扣任何积分。',
          { details: { required: credits, seats } },
        )
      throw err
    }
    this.deps.wallet.settle(reservation, { quantity: seats, credits })
  }

  /**
   * 开通（或续一期）。
   *
   * 已经在跑的工作区再调一次只是**重新拉起来**，不重复收钱——用户点两下开通按钮
   * 不该被扣两个月。
   */
  async open(input: {
    org_id: string
    account_id: string
    workspace_id: WorkspaceId
    seats: number
  }): Promise<StandbyWorkspace> {
    const workspace_id = assertWorkspaceId(input.workspace_id)
    const seats = Math.trunc(input.seats)
    if (!Number.isFinite(seats) || seats < 1 || seats > MAX_SEATS)
      throw new StandbyError('invalid_input', `座位数要在 1 到 ${String(MAX_SEATS)} 之间`)
    const at = this.now()
    const existing = this.deps.store.get(workspace_id)
    if (existing !== undefined && existing.org_id !== input.org_id)
      throw new StandbyError('forbidden', '这个工作区的值守属于另一个账号。')

    if (existing !== undefined && existing.period_end > at && existing.seats === seats) {
      // 这一期还没到，座位数也没变：只把进程拉起来，不收第二次钱
      const started = await this.pool.start(existing)
      return toView(started)
    }

    this.chargeMonth(input.org_id, workspace_id, seats)
    const base: StandbyRecord = existing ?? {
      workspace_id,
      org_id: input.org_id,
      owner_account_id: input.account_id,
      status: 'starting',
      seats,
      period_end: at,
      created_at: at,
      restarts: 0,
    }
    const record: StandbyRecord = {
      ...base,
      org_id: input.org_id,
      seats,
      // 续期从"这一期结束"起算；过期太久就从现在起算（不补送已经过去的那几天）
      period_end: plusDays(base.period_end > at ? base.period_end : at, STANDBY_PERIOD_DAYS),
      status: 'starting',
      restarts: 0,
    }
    delete record.renewal_notified_at
    delete record.reason
    this.deps.store.put(record)
    const started = await this.pool.start(record)
    return toView(started)
  }

  /** 用户自己停。数据不删，导出照常（41 §2.3）。 */
  stop(workspace_id: WorkspaceId, reason = '用户停了值守'): StandbyWorkspace {
    const id = assertWorkspaceId(workspace_id)
    const record = this.deps.store.get(id)
    if (record === undefined) throw new StandbyError('not_found', '这个工作区没有开值守。')
    this.pool.stop(id, reason)
    const after = this.deps.store.get(id)
    return toView(after ?? record)
  }

  /**
   * 上传一个 WP36 导出包 → 校验 → 解到这个租户的目录 → 起进程。
   *
   * 顺序不能换：**先校验再解包**。反过来的话，一个坏包会先把半个目录铺进去，
   * 然后我们才发现它坏——那时候这个租户的数据已经是"一半新一半旧"了。
   */
  async importAndStart(input: {
    org_id: string
    account_id: string
    workspace_id: WorkspaceId
    zip: Uint8Array
    seats: number
    force?: boolean
  }): Promise<StandbyWorkspace> {
    const workspace_id = assertWorkspaceId(input.workspace_id)
    const existing = this.deps.store.get(workspace_id)
    if (existing !== undefined && existing.org_id !== input.org_id)
      throw new StandbyError('forbidden', '这个工作区的值守属于另一个账号。')
    if (existing !== undefined && shouldRun(existing.status))
      throw new StandbyError(
        'conflict',
        '这个工作区的服务正在云上跑。先停了再导入——一边跑一边换库底下的文件，换出来的是一份谁也读不懂的东西。',
      )

    const dataDir = this.pool.dataDirOf(workspace_id)
    if (!this.deps.fs.isEmptyDir(dataDir) && input.force !== true)
      throw new StandbyError(
        'conflict',
        '这个工作区在云上已经有数据了。要用新的包覆盖，得显式确认一次——默认不覆盖。',
      )

    const temp = this.deps.fs.writeTemp('workspace.zip', input.zip)
    try {
      // WP36 的 importPackage 自己核 manifest + 每个文件的 sha256 + zip 的 crc；
      // 任意一处对不上就抛，租户目录一个字节都不动
      await this.deps.packager.importPackage({
        zip: temp.path,
        dataDir,
        ...(input.force === undefined ? {} : { force: input.force }),
      })
    } catch (err) {
      throw new StandbyError(
        'corrupt_package',
        `这个包不能用：${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      temp.dispose()
    }
    return this.open({
      org_id: input.org_id,
      account_id: input.account_id,
      workspace_id,
      seats: input.seats,
    })
  }

  /**
   * 反向搬家：把云上这一份导出来。
   *
   * 到期停了的照样能导（41 §2.3 第一条纪律）。正在跑的先停——`VACUUM INTO` 那一份
   * 是一致的，但"导完就把本地当真源"的用户会同时有两个在写的服务进程。
   */
  async exportPackage(workspace_id: WorkspaceId): Promise<{ bytes: Uint8Array; name: string }> {
    const id = assertWorkspaceId(workspace_id)
    const record = this.deps.store.get(id)
    if (record === undefined) throw new StandbyError('not_found', '这个工作区没有开值守。')
    const dataDir = this.pool.dataDirOf(id)
    if (this.deps.fs.isEmptyDir(dataDir))
      throw new StandbyError('not_found', '这个工作区在云上还没有数据。')
    const name = `${id}-${this.now().replace(/[-:]/g, '').slice(0, 15)}.zip`
    const out = this.deps.fs.writeTemp(name, new Uint8Array())
    try {
      await this.deps.packager.exportPackage({ dataDir, workspace_id: id, out: out.path })
      return { bytes: this.deps.fs.readFile(out.path), name }
    } finally {
      out.dispose()
    }
  }

  /**
   * 一拍：续费提醒 → 到期续费 / 停 → 进程体检与退避重启。
   *
   * 顺序有讲究：先把到期这件事结掉，再让进程池去拉——否则刚判成 `expired` 的那个
   * 会在同一拍里被重新拉起来。
   */
  async tick(): Promise<void> {
    const at = this.now()
    for (const record of this.deps.store.list()) {
      if (record.status === 'expired') continue
      const due = Date.parse(record.period_end)
      const lead = Date.parse(at) + STANDBY_RENEWAL_LEAD_DAYS * DAY_MS

      if (due > Date.parse(at)) {
        // 还没到期：到期前 3 天出一条提醒，一期只出一次
        if (due <= lead && record.renewal_notified_at === undefined) {
          this.deps.store.put({ ...record, renewal_notified_at: at })
          this.emit({
            type: 'standby.renewal_due',
            workspace_id: record.workspace_id,
            org_id: record.org_id,
            at,
            period_end: record.period_end,
            credits_due: this.monthlyCredits(record.seats),
            reason: '值守订阅快到期了，余额不足会在到期那天停',
          })
        }
        continue
      }

      // 到期了：试着续一期；钱不够就停（数据不删，导出照常）
      try {
        this.chargeMonth(record.org_id, record.workspace_id, record.seats)
      } catch (err) {
        if (err instanceof StandbyError && err.code === 'insufficient_credits') {
          this.pool.stop(
            record.workspace_id,
            '订阅到期、余额不足，已停。数据都在，导出照常。',
            'expired',
          )
          continue
        }
        throw err
      }
      const renewed: StandbyRecord = {
        ...record,
        period_end: plusDays(record.period_end, STANDBY_PERIOD_DAYS),
      }
      delete renewed.renewal_notified_at
      this.deps.store.put(renewed)
    }
    await this.pool.tick()
  }

  async close(): Promise<void> {
    await this.pool.close()
    this.deps.store.close?.()
  }
}
