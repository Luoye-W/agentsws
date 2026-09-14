/**
 * WP55 / 48 §4 L3 #5：邮箱加固四件事。
 *
 * 每一条用例背后都是一种真实的事故形态：重启从头拉、一封畸形信卡住整只邮箱、
 * 两个进程同时扫同一只邮箱、归档文件夹建不出来把收信也拖挂。
 */
import type { Clock } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  advanceCursor,
  clearFault,
  DEFAULT_SCAN_LEASE_MS,
  EmailChannelAdapter,
  isSkipped,
  type MailboxStateStore,
  type MailSource,
  MemoryMailboxStateStore,
  MemoryRawStore,
  POISON_MESSAGE_MAX_ATTEMPTS,
  type RawEmailMessage,
  recordFault,
  resumeFrom,
  SqliteMailboxStateStore,
} from '../src/index.js'

const T0 = '2026-09-10T00:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }
const ADDRESS = 'support@shop.example'

const mime = (n: number): string =>
  [
    'From: ann@customer.com',
    `To: ${ADDRESS}`,
    `Subject: letter ${n}`,
    `Message-ID: <m-${n}@mail.example>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `body ${n}`,
    '',
  ].join('\r\n')

/** 可控的收信端：给定信件、可控的 `uidValidity`、记录归档调用。 */
class FakeSource implements MailSource {
  uid_validity = 1
  readonly archived: number[] = []
  archive_ok = true
  readonly fetched: number[] = []
  constructor(private readonly messages: RawEmailMessage[]) {}
  async fetchSince(since_uid: number): Promise<RawEmailMessage[]> {
    this.fetched.push(since_uid)
    return this.messages.filter((m) => m.uid > since_uid)
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async uidValidity(): Promise<number> {
    return this.uid_validity
  }
  async archive(uid: number): Promise<boolean> {
    if (!this.archive_ok) return false
    this.archived.push(uid)
    return true
  }
}

const letters = (uids: number[]): RawEmailMessage[] =>
  uids.map((uid) => ({ uid, mailbox: 'INBOX', source: mime(uid) }))

function adapter(
  source: MailSource,
  state: MailboxStateStore,
  over: Partial<ConstructorParameters<typeof EmailChannelAdapter>[0]> = {},
): EmailChannelAdapter {
  return new EmailChannelAdapter({
    clock,
    rawStore: new MemoryRawStore({ clock }),
    address: ADDRESS,
    source,
    mailbox_state: state,
    scan_owner: 'proc_a',
    ...over,
  })
}

describe('① 每文件夹 UID 游标持久化', () => {
  it('纯函数：uid_validity 变了 = 旧水位全部作废，从 0 重来', () => {
    const cursor = { folder: 'INBOX', uid_validity: 7, last_seen_uid: 42 }
    expect(resumeFrom(cursor, 7)).toBe(42)
    // 服务器重建过邮箱：继续用旧水位会静默漏掉所有信
    expect(resumeFrom(cursor, 8)).toBe(0)
    expect(resumeFrom(undefined, 7)).toBe(0)
    // 水位只进不退
    expect(advanceCursor(cursor, 'INBOX', 7, 10).last_seen_uid).toBe(42)
    expect(advanceCursor(cursor, 'INBOX', 7, 99).last_seen_uid).toBe(99)
    // 换了 uid_validity 就从这一封重新起算
    expect(advanceCursor(cursor, 'INBOX', 8, 3).last_seen_uid).toBe(3)
  })

  it('重启不重拉：新适配器读同一份游标，从上次那封之后开始', async () => {
    const state = new MemoryMailboxStateStore()
    const source = new FakeSource(letters([1, 2, 3]))
    const seen: number[] = []
    const a = adapter(source, state)
    expect(await a.poll(async (raw) => void seen.push((raw as RawEmailMessage).uid))).toBe(3)
    expect(seen).toEqual([1, 2, 3])

    // 换一个适配器实例（= 进程重启）：水位还在
    const b = adapter(new FakeSource(letters([1, 2, 3])), state)
    expect(await b.poll(async () => undefined)).toBe(0)
    expect(state.cursor(ADDRESS, 'INBOX')).toMatchObject({ last_seen_uid: 3, uid_validity: 1 })
  })

  it('服务器重建邮箱（uid_validity 变了）→ 重新从头拉一遍', async () => {
    const state = new MemoryMailboxStateStore()
    const first = new FakeSource(letters([1, 2]))
    await adapter(first, state).poll(async () => undefined)

    const second = new FakeSource(letters([1, 2]))
    second.uid_validity = 2
    const handled: number[] = []
    await adapter(second, state).poll(
      async (raw) => void handled.push((raw as RawEmailMessage).uid),
    )
    expect(second.fetched).toEqual([0])
    expect(handled).toEqual([1, 2])
  })
})

describe('② 毒消息隔离', () => {
  it('纯函数：连续失败到阈值才永久越过，没到就下一轮再试', () => {
    let fault = recordFault(undefined, { folder: 'INBOX', uid: 5, error: 'bad mime', at: T0 })
    expect(fault.quarantined).toBe(false)
    expect(fault.fault.fail_count).toBe(1)
    for (let i = 1; i < POISON_MESSAGE_MAX_ATTEMPTS; i += 1) {
      fault = recordFault(fault.fault, { folder: 'INBOX', uid: 5, error: 'bad mime', at: T0 })
    }
    expect(fault.quarantined).toBe(true)
    expect(fault.fault.skipped_uids).toEqual([5])
    expect(isSkipped(fault.fault, 5)).toBe(true)
    // 换了一封信：计数重新从 1 开始（不是同一封的连续失败）
    const other = recordFault(fault.fault, { folder: 'INBOX', uid: 6, error: 'x', at: T0 })
    expect(other.fault.fail_count).toBe(1)
    // 成功一次就把计数清掉
    expect(clearFault(other.fault, 'INBOX', 6)?.fail_count).toBe(0)
  })

  it('一封炸了的信不挡住后面的：跳过它，继续拉', async () => {
    const state = new MemoryMailboxStateStore()
    const source = new FakeSource(letters([1, 2, 3]))
    const seen: number[] = []
    const a = adapter(source, state)
    const handled = await a.poll(async (raw) => {
      const uid = (raw as RawEmailMessage).uid
      if (uid === 2) throw new Error('畸形 MIME')
      seen.push(uid)
    })
    expect(handled).toBe(2)
    expect(seen).toEqual([1, 3])
    // 隔离表里记了一笔，但还没到永久越过的阈值
    expect(state.fault(ADDRESS, 'INBOX')).toMatchObject({ failed_uid: 2, fail_count: 1 })
    expect(state.fault(ADDRESS, 'INBOX')?.skipped_uids).toEqual([])
  })

  it('连续炸到阈值 → 永久越过并出一张卡；下一轮连拉都不再拉它', async () => {
    const state = new MemoryMailboxStateStore()
    const cards: { quarantined: boolean; failed_uid?: number }[] = []
    const boom = async (raw: unknown): Promise<void> => {
      if ((raw as RawEmailMessage).uid === 1) throw new Error('畸形 MIME')
    }
    for (let round = 0; round < POISON_MESSAGE_MAX_ATTEMPTS; round += 1) {
      const a = adapter(new FakeSource(letters([1, 2])), state, {
        on_folder_fault: (f) => {
          cards.push({
            quarantined: f.quarantined,
            ...(f.failed_uid === undefined ? {} : { failed_uid: f.failed_uid }),
          })
        },
      })
      await a.poll(boom)
    }
    expect(cards.filter((c) => c.quarantined)).toHaveLength(1)
    expect(state.fault(ADDRESS, 'INBOX')?.skipped_uids).toEqual([1])
    // 永久越过之后水位才推过它，新信照常进来
    expect(state.cursor(ADDRESS, 'INBOX')?.last_seen_uid).toBe(2)
    const later = new FakeSource(letters([1, 2, 3]))
    const seen: number[] = []
    await adapter(later, state).poll(async (raw) => void seen.push((raw as RawEmailMessage).uid))
    expect(seen).toEqual([3])
  })

  it('水位不推过卡住的那一封：下一轮把它和它后面的一起重拉', async () => {
    const state = new MemoryMailboxStateStore()
    const first = new FakeSource(letters([1, 2]))
    await adapter(first, state).poll(async (raw) => {
      if ((raw as RawEmailMessage).uid === 1) throw new Error('畸形 MIME')
    })
    // uid 2 成功了，但水位留在 uid 1 前面——只失败一次就永久跳过是不对的，
    // 那一次多半只是那一瞬间的抖动。重复的那几封由去重表挡住。
    expect(state.cursor(ADDRESS, 'INBOX')).toBeUndefined()
    const second = new FakeSource(letters([1, 2]))
    const seen: number[] = []
    await adapter(second, state).poll(async (raw) => void seen.push((raw as RawEmailMessage).uid))
    expect(second.fetched).toEqual([0])
    expect(seen).toEqual([1, 2])
    expect(state.cursor(ADDRESS, 'INBOX')?.last_seen_uid).toBe(2)
  })
})

describe('③ 扫描租约', () => {
  it('同一只邮箱同时只有一个进程在扫；领不到就让开', async () => {
    const state = new MemoryMailboxStateStore()
    expect(state.claimScanLease(ADDRESS, 'proc_b', Date.parse(T0), DEFAULT_SCAN_LEASE_MS)).toBe(
      true,
    )

    const source = new FakeSource(letters([1, 2]))
    const a = adapter(source, state)
    expect(await a.poll(async () => undefined)).toBe(0)
    expect(a.lastPollWasLeaseBusy).toBe(true)
    // 一封都没拉——别人正在扫
    expect(source.fetched).toEqual([])
  })

  it('租约到期自动释放：持有者崩在半路不该把这只邮箱锁死', async () => {
    const state = new MemoryMailboxStateStore()
    state.claimScanLease(
      ADDRESS,
      'proc_b',
      Date.parse(T0) - DEFAULT_SCAN_LEASE_MS - 1,
      DEFAULT_SCAN_LEASE_MS,
    )
    const source = new FakeSource(letters([1]))
    const a = adapter(source, state)
    expect(await a.poll(async () => undefined)).toBe(1)
    expect(a.lastPollWasLeaseBusy).toBe(false)
  })

  it('拉完就释放，下一个进程立刻领得到', async () => {
    const state = new MemoryMailboxStateStore()
    await adapter(new FakeSource(letters([1])), state).poll(async () => undefined)
    expect(state.claimScanLease(ADDRESS, 'proc_b', Date.parse(T0), 1000)).toBe(true)
  })

  it('SQLite 档：领取是条件写，第二个进程领不到', () => {
    const store = new SqliteMailboxStateStore()
    const now = Date.parse(T0)
    expect(store.claimScanLease(ADDRESS, 'proc_a', now, 60_000)).toBe(true)
    expect(store.claimScanLease(ADDRESS, 'proc_b', now, 60_000)).toBe(false)
    // 同一个持有者续租是可以的
    expect(store.claimScanLease(ADDRESS, 'proc_a', now + 1_000, 60_000)).toBe(true)
    // 过期之后别人领得到
    expect(store.claimScanLease(ADDRESS, 'proc_b', now + 200_000, 60_000)).toBe(true)
    store.releaseScanLease(ADDRESS, 'proc_b')
    expect(store.claimScanLease(ADDRESS, 'proc_c', now + 200_001, 60_000)).toBe(true)
    store.close()
  })

  it('SQLite 档：游标与隔离表落盘，换实例还认得出', () => {
    const store = new SqliteMailboxStateStore()
    store.setCursor(ADDRESS, { folder: 'INBOX', uid_validity: 3, last_seen_uid: 88 })
    store.setFault(ADDRESS, {
      folder: 'INBOX',
      failed_uid: 5,
      fail_count: 2,
      last_error: 'bad mime',
      last_failed_at: T0,
      skipped_uids: [4],
    })
    expect(store.cursor(ADDRESS, 'INBOX')).toEqual({
      folder: 'INBOX',
      uid_validity: 3,
      last_seen_uid: 88,
    })
    expect(store.faults(ADDRESS)[0]).toMatchObject({ failed_uid: 5, skipped_uids: [4] })
    store.close()
  })
})

describe('④ agentsws 归档文件夹', () => {
  it('处理过的信搬进归档；不配置就不搬（这条可关）', async () => {
    const state = new MemoryMailboxStateStore()
    const source = new FakeSource(letters([1, 2]))
    await adapter(source, state, { archive_folder: 'agentsws' }).poll(async () => undefined)
    expect(source.archived).toEqual([1, 2])

    const off = new FakeSource(letters([1, 2]))
    await adapter(off, new MemoryMailboxStateStore()).poll(async () => undefined)
    expect(off.archived).toEqual([])
  })

  it('搬不动只 log，不影响收信（游标照常推进）', async () => {
    const state = new MemoryMailboxStateStore()
    const source = new FakeSource(letters([1, 2]))
    source.archive_ok = false
    const errors: unknown[] = []
    const handled = await adapter(source, state, {
      archive_folder: 'agentsws',
      on_error: (e) => errors.push(e),
    }).poll(async () => undefined)
    expect(handled).toBe(2)
    expect(state.cursor(ADDRESS, 'INBOX')?.last_seen_uid).toBe(2)
    expect(errors).toHaveLength(2)
    expect(String(errors[0])).toContain('归档文件夹动不了')
  })

  it('炸掉的那封不归档（它根本没处理成功）', async () => {
    const state = new MemoryMailboxStateStore()
    const source = new FakeSource(letters([1, 2]))
    await adapter(source, state, { archive_folder: 'agentsws' }).poll(async (raw) => {
      if ((raw as RawEmailMessage).uid === 1) throw new Error('畸形 MIME')
    })
    expect(source.archived).toEqual([2])
  })
})
