/**
 * WP163：只有判成客服的信才标已读 / 挪进 `KefuAgents`，四个开关照老产品 KefuAgent。
 */
import { type Clock, SUPPORT_FOLDER } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  applySupportMailboxActions,
  EmailChannelAdapter,
  type MailboxActionRecord,
  type MailSource,
  MemoryMailboxStateStore,
  MemoryRawStore,
  type RawEmailMessage,
  SUPPORT_MAILBOX_DEFAULTS,
  safeActionDetail,
  supportMailboxSwitches,
} from '../src/index.js'

const T0 = '2026-09-27T00:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }
const ADDRESS = 'support@shop.example'

const mime = (n: number): string =>
  [
    'From: ann@customer.com',
    `To: ${ADDRESS}`,
    `Subject: letter ${n}`,
    `Message-ID: <m-${n}@mail.example>`,
    '',
    `body ${n}`,
    '',
  ].join('\r\n')

/** 替身 IMAP：记下每一次标已读 / 挪信。 */
class Box implements MailSource {
  readonly moved: { uid: number; to: string; mark_read: boolean }[] = []
  readonly marked: number[] = []
  move_ok = true
  constructor(
    private readonly uids: number[],
    readonly withMarkRead = true,
  ) {
    if (!withMarkRead) (this as { markRead?: unknown }).markRead = undefined
  }
  async fetchSince(since: number): Promise<RawEmailMessage[]> {
    return this.uids
      .filter((u) => u > since)
      .map((uid) => ({ uid, mailbox: 'INBOX', source: mime(uid) }))
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async listFolders(): Promise<string[]> {
    return ['INBOX', 'kefuagents']
  }
  async archive(uid: number, to: string, mark_read: boolean): Promise<boolean> {
    if (!this.move_ok) return false
    this.moved.push({ uid, to, mark_read })
    return true
  }
  async markRead(uid: number): Promise<boolean> {
    this.marked.push(uid)
    return true
  }
}

function adapterOn(
  box: MailSource,
  over: Partial<ConstructorParameters<typeof EmailChannelAdapter>[0]> = {},
): { adapter: EmailChannelAdapter; actions: MailboxActionRecord[] } {
  const actions: MailboxActionRecord[] = []
  const adapter = new EmailChannelAdapter({
    clock,
    rawStore: new MemoryRawStore({ clock }),
    address: ADDRESS,
    source: box,
    mailbox_state: new MemoryMailboxStateStore(),
    archive_folder: SUPPORT_FOLDER,
    on_mailbox_action: (r) => actions.push(r),
    ...over,
  })
  return { adapter, actions }
}

/** uid 为偶数的判成客服，奇数的不是。 */
const evenIsSupport = async (raw: unknown) => ({
  support: (raw as RawEmailMessage).uid % 2 === 0,
})

describe('WP163 客服收信那一路：只挪判成客服的信', () => {
  it('非客服信原地不动、不标已读、不记账；客服信先标已读再挪进已有的那只', async () => {
    const box = new Box([1, 2, 3, 4])
    const { adapter, actions } = adapterOn(box)
    await adapter.poll(evenIsSupport)
    expect(box.marked).toEqual([2, 4])
    expect(box.moved).toEqual([
      { uid: 2, to: 'kefuagents', mark_read: false },
      { uid: 4, to: 'kefuagents', mark_read: false },
    ])
    expect(actions.map((a) => `${a.uid}:${a.action}:${a.status}`)).toEqual([
      '2:mark_read:completed',
      '2:move:completed',
      '4:mark_read:completed',
      '4:move:completed',
    ])
  })

  it('影子模式：只记一笔「跳过」，邮箱一下都不动', async () => {
    const box = new Box([2])
    const { adapter, actions } = adapterOn(box, { support_mailbox: { shadow_mode: true } })
    await adapter.poll(evenIsSupport)
    expect(box.marked).toEqual([])
    expect(box.moved).toEqual([])
    expect(actions).toEqual([
      expect.objectContaining({ action: 'observe', status: 'skipped', reason: 'shadow_mode' }),
    ])
  })

  it('挪信关、标已读开：只标已读，挪信记「跳过」', async () => {
    const box = new Box([2])
    const { adapter, actions } = adapterOn(box, { support_mailbox: { move: false } })
    await adapter.poll(evenIsSupport)
    expect(box.marked).toEqual([2])
    expect(box.moved).toEqual([])
    expect(actions.map((a) => `${a.action}:${a.status}:${a.reason ?? ''}`)).toEqual([
      'mark_read:completed:',
      'move:skipped:move_disabled',
    ])
  })

  it('标已读关（archive_mark_read: false）：只挪不标', async () => {
    const box = new Box([2])
    const { adapter } = adapterOn(box, { archive_mark_read: false })
    await adapter.poll(evenIsSupport)
    expect(box.marked).toEqual([])
    expect(box.moved).toEqual([{ uid: 2, to: 'kefuagents', mark_read: false }])
  })

  it('没配归档文件夹 = 这一路不动邮箱，一笔都不记（挪信归消息同步时就是这样）', async () => {
    const box = new Box([2])
    const actions: MailboxActionRecord[] = []
    const adapter = new EmailChannelAdapter({
      clock,
      rawStore: new MemoryRawStore({ clock }),
      address: ADDRESS,
      source: box,
      on_mailbox_action: (r) => actions.push(r),
    })
    await adapter.poll(evenIsSupport)
    expect(box.moved).toEqual([])
    expect(box.marked).toEqual([])
    expect(actions).toEqual([])
  })

  it('判成客服但那一侧没接：记「跳过」+ 原因，不动', async () => {
    const box = new Box([2])
    const { adapter, actions } = adapterOn(box)
    await adapter.poll(async () => ({ support: true, skip: 'handoff_refused' }))
    expect(box.moved).toEqual([])
    expect(actions).toEqual([
      expect.objectContaining({ action: 'move', status: 'skipped', reason: 'handoff_refused' }),
    ])
  })

  it('挪不动记「失败」，收信照常', async () => {
    const box = new Box([2, 4])
    box.move_ok = false
    const { adapter, actions } = adapterOn(box)
    expect(await adapter.poll(evenIsSupport)).toBe(2)
    expect(actions.filter((a) => a.action === 'move')).toEqual([
      expect.objectContaining({ uid: 2, status: 'failed', reason: 'server_refused' }),
      expect.objectContaining({ uid: 4, status: 'failed', reason: 'server_refused' }),
    ])
  })

  it('收信端没有单独的标已读：合进挪信那一步（WP55 的 archive）', async () => {
    const box = new Box([2], false)
    const { adapter, actions } = adapterOn(box)
    await adapter.poll(evenIsSupport)
    expect(box.moved).toEqual([{ uid: 2, to: 'kefuagents', mark_read: true }])
    expect(actions.map((a) => `${a.action}:${a.status}`)).toEqual([
      'mark_read:completed',
      'move:completed',
    ])
  })
})

describe('WP163 纯函数：顺序与默认值照老产品', () => {
  it('默认值：影子模式关、接管开、挪信开、标已读开', () => {
    expect(SUPPORT_MAILBOX_DEFAULTS).toEqual({
      shadow_mode: false,
      folder_enabled: true,
      move: true,
      mark_read: true,
    })
    expect(supportMailboxSwitches({ move: undefined, shadow_mode: true })).toMatchObject({
      move: true,
      shadow_mode: true,
    })
  })

  it('接管关：记「跳过」、不动；标已读失败不挡挪信；已在目标文件夹里不挪', async () => {
    const log: MailboxActionRecord[] = []
    const base = {
      account: ADDRESS,
      uid: 7,
      from_folder: 'INBOX',
      record: (r: MailboxActionRecord) => void log.push(r),
    }
    const off = await applySupportMailboxActions({
      ...base,
      switches: supportMailboxSwitches({ folder_enabled: false }),
      to_folder: 'KefuAgents',
      ops: { move: async () => true },
    })
    expect(off).toEqual({ marked_read: false, moved: false })
    expect(log.pop()).toMatchObject({ action: 'observe', reason: 'folder_disabled' })

    const out = await applySupportMailboxActions({
      ...base,
      switches: SUPPORT_MAILBOX_DEFAULTS,
      to_folder: 'KefuAgents',
      ops: {
        markRead: async () => {
          throw new Error('NO [CANNOT] boss@shop.example is locked')
        },
        move: async () => true,
      },
    })
    expect(out).toEqual({ marked_read: false, moved: true })
    expect(log.splice(0)).toEqual([
      expect.objectContaining({
        action: 'mark_read',
        status: 'failed',
        reason: 'error',
        detail: 'NO [CANNOT] *** is locked',
      }),
      expect.objectContaining({ action: 'move', status: 'completed', to_folder: 'KefuAgents' }),
    ])

    const already = await applySupportMailboxActions({
      ...base,
      from_folder: 'kefuagents',
      switches: SUPPORT_MAILBOX_DEFAULTS,
      to_folder: 'KefuAgents',
      ops: { markRead: async () => true, move: async () => true },
    })
    expect(already).toEqual({ marked_read: true, moved: false })
    expect(log.map((r) => r.action)).toEqual(['mark_read'])
  })

  it('失败原因里的邮箱地址遮掉、截断', () => {
    expect(safeActionDetail(new Error('a@b.com and <c.d@e.f>'))).toBe('*** and <***>')
    expect(safeActionDetail('x'.repeat(500))).toHaveLength(160)
  })
})
