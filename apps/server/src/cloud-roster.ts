/**
 * WP206：把本机公司的**名册**推上云——网页版账号页「成员额度」要列人（还没设过上限的人也要能设）。
 *
 * 推什么：成员 `person_id` + 显示名 + 他持有的岗位 id、岗位 id + 名字。**只有这些名字，不带任何业务内容。**
 *
 * 什么时候推（只在已关联时）：
 * - 启动时一次（{@link RosterSync.start}）；
 * - 名册变了一次（{@link RosterSync.poke}：加人 / 删人 / 岗位增删改名 / 分配变了；攒 2 秒合成一次）；
 * - 之后每天一次（即使没变：云上据此知道这份名册还是新的）。
 *
 * 没变就不推（按内容算指纹；每天那一次除外）。推失败不报错：下一次变动或下一天再推。
 * 名册一个人都没有时不推——一家公司至少有所有者，空名册多半是本机读坏了；推上去会让云上把全公司都停用。
 */
import { createHash } from 'node:crypto'
import type { AllocationRosterRequest } from '@agentsws/contracts'

/** 名册变动后攒多久再推（连着改好几处只推一次）。 */
export const ROSTER_DEBOUNCE_MS = 2_000
/** 没变动也每天推一次。 */
export const ROSTER_DAILY_MS = 24 * 60 * 60_000

/** 哪些事件算「名册变了」（组织面 `org.ts` 发的那几种）。 */
export function isRosterEvent(type: string): boolean {
  return (
    type.startsWith('membership.') ||
    type.startsWith('position.') ||
    type === 'invitation.accepted' ||
    type === 'assignment.granted' ||
    type === 'assignment.revoked' ||
    // 刚关联上：之前一次都没推过（或推给的是别的组织），推一份
    type === 'cloud.account_linked'
  )
}

export interface RosterSyncOptions {
  /** 现读名册。读不出来抛错就这一轮不推。 */
  build: () => Promise<AllocationRosterRequest>
  /** 推一次；回推成功没有。 */
  push: (roster: AllocationRosterRequest) => Promise<boolean>
  /** 现在关联着没有（没关联什么都不做）。 */
  linked: () => boolean
  debounceMs?: number
  dailyMs?: number
}

export interface RosterSync {
  /** 启动：立刻推一次，之后每天一次。 */
  start(): void
  /** 名册变了：攒一会儿再推（内容没变就不推；`force` = 没变也推，比如刚关联上）。 */
  poke(force?: boolean): void
  /** 现在就推一次（`force` = 内容没变也推）。回推成功没有；没推（没关联 / 没变 / 空名册）回 `false`。 */
  syncNow(force?: boolean): Promise<boolean>
  close(): void
}

/** 名册的指纹（顺序无关：先排好再算）。 */
export function rosterFingerprint(roster: AllocationRosterRequest): string {
  const members = [...roster.members]
    .map((m) => ({ id: m.id, name: m.name, positions: [...(m.positions ?? [])].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const positions = [...roster.positions].sort((a, b) => a.id.localeCompare(b.id))
  return createHash('sha256').update(JSON.stringify({ members, positions })).digest('hex')
}

export function createRosterSync(options: RosterSyncOptions): RosterSync {
  const debounceMs = options.debounceMs ?? ROSTER_DEBOUNCE_MS
  const dailyMs = options.dailyMs ?? ROSTER_DAILY_MS
  let lastPushed: string | undefined
  let pending: ReturnType<typeof setTimeout> | undefined
  let daily: ReturnType<typeof setInterval> | undefined
  let running: Promise<boolean> | undefined
  let closed = false
  let forceNext = false

  const once = async (force: boolean): Promise<boolean> => {
    if (closed || !options.linked()) return false
    let roster: AllocationRosterRequest
    try {
      roster = await options.build()
    } catch {
      return false
    }
    if (roster.members.length === 0) return false
    const print = rosterFingerprint(roster)
    if (!force && print === lastPushed) return false
    const ok = await options.push(roster).catch(() => false)
    if (ok) lastPushed = print
    return ok
  }

  const syncNow = async (force = false): Promise<boolean> => {
    // 一次只推一份：正在推的时候又来一次，等它推完再按最新的名册推
    while (running !== undefined) await running.catch(() => false)
    running = once(force)
    try {
      return await running
    } finally {
      running = undefined
    }
  }

  return {
    start() {
      if (closed) return
      void syncNow(true)
      if (daily === undefined) {
        daily = setInterval(() => {
          void syncNow(true)
        }, dailyMs)
        daily.unref?.()
      }
    },
    poke(force = false) {
      if (closed) return
      if (force) forceNext = true
      if (pending !== undefined) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = undefined
        const f = forceNext
        forceNext = false
        void syncNow(f)
      }, debounceMs)
      pending.unref?.()
    },
    syncNow,
    close() {
      closed = true
      if (pending !== undefined) clearTimeout(pending)
      if (daily !== undefined) clearInterval(daily)
      pending = undefined
      daily = undefined
    },
  }
}
