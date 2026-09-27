/**
 * WP163：消息同步那一路（挪信的唯一负责方）照老产品 KefuAgent 的四个开关动邮箱，
 * 而且已经在岗位文件夹里的信不再被自动挪来挪去。
 */
import type { Clock, MessageRecord, MessageRoute, MessageTriage } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { MailSource, RawEmailMessage } from '../src/email/imap.js'
import {
  type MailboxActionRecord,
  MailboxSync,
  MemoryMailboxStateStore,
  MemoryMessageStore,
  type SupportMailboxSwitches,
} from '../src/index.js'
import type { MailboxWriter } from '../src/messages/writeback.js'

const T0 = '2026-09-27T02:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }
const ME = 'hello@shop.example'

const mime = (n: number): string =>
  [
    'From: ann@customer.example',
    `To: ${ME}`,
    `Subject: letter ${n}`,
    `Message-ID: <m-${n}@customer.example>`,
    'Date: Sat, 26 Sep 2026 10:00:00 +0000',
    '',
    `body ${n}`,
    '',
  ].join('\r\n')

class FolderSource implements MailSource {
  constructor(private readonly messages: RawEmailMessage[]) {}
  async fetchSince(since: number): Promise<RawEmailMessage[]> {
    return this.messages.filter((m) => m.uid > since)
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
}

/** 替身回写端：按调用顺序记下每一步。 */
class Writer implements MailboxWriter {
  readonly calls: string[] = []
  move_ok = true
  setFlags(folder: string, uid: number, add: readonly string[]): boolean {
    this.calls.push(`flag ${folder}/${uid} +${add.join(',')}`)
    return true
  }
  move(folder: string, uid: number, to: string): boolean {
    if (!this.move_ok) return false
    this.calls.push(`move ${folder}/${uid} → ${to}`)
    return true
  }
}

const triageAs = (route: MessageRoute) => async (): Promise<MessageTriage> => ({
  route,
  labels: [],
  needs_reply: route !== 'inbox',
  priority: 'normal',
  summary: '',
  confidence: 0.95,
  by: 'model',
  reasons: [],
  at: T0,
})

function run(opts: {
  folders: Record<string, RawEmailMessage[]>
  route: MessageRoute
  handoff?: boolean
  switches?: Partial<SupportMailboxSwitches>
}): { sync: MailboxSync; writer: Writer; store: MemoryMessageStore; log: MailboxActionRecord[] } {
  const writer = new Writer()
  const store = new MemoryMessageStore()
  const log: MailboxActionRecord[] = []
  const sync = new MailboxSync({
    clock,
    workspace_id: 'ws_1',
    store,
    state: new MemoryMailboxStateStore(),
    accounts: () => [
      {
        address: ME,
        folders: Object.keys(opts.folders),
        known_folders: ['INBOX', 'KefuAgents', 'KOLAgents'],
        open: (folder) => new FolderSource(opts.folders[folder] ?? []),
        writer,
      },
    ],
    triage: triageAs(opts.route),
    handoff: async (_r: MessageRecord) => opts.handoff ?? true,
    support_mailbox: () => opts.switches ?? {},
    on_mailbox_action: (r) => log.push(r),
  })
  return { sync, writer, store, log }
}

const inbox = (uid: number): Record<string, RawEmailMessage[]> => ({
  INBOX: [{ uid, mailbox: 'INBOX', source: mime(uid) }],
})

describe('WP163 消息同步：判成客服的信照老产品的开关动邮箱', () => {
  it('默认：先在收件箱里标已读，再挪进 KefuAgents；库里跟着改', async () => {
    const { sync, writer, store, log } = run({ folders: inbox(7), route: 'support' })
    expect((await sync.sync()).moved).toBe(1)
    expect(writer.calls).toEqual(['flag INBOX/7 +\\Seen', 'move INBOX/7 → KefuAgents'])
    const row = (await store.list({}))[0]
    expect(row?.folder).toBe('KefuAgents')
    expect(row?.flags.read).toBe(true)
    expect(log.map((r) => `${r.action}:${r.status}`)).toEqual([
      'mark_read:completed',
      'move:completed',
    ])
    // 记账里没有正文，只有文件夹与 uid
    expect(JSON.stringify(log)).not.toContain('body 7')
  })

  it('影子模式：一下都不动，只记一笔', async () => {
    const { sync, writer, log } = run({
      folders: inbox(7),
      route: 'support',
      switches: { shadow_mode: true },
    })
    expect((await sync.sync()).moved).toBe(0)
    expect(writer.calls).toEqual([])
    expect(log).toEqual([expect.objectContaining({ action: 'observe', reason: 'shadow_mode' })])
  })

  it('影子模式对红人那只也生效', async () => {
    const { sync, writer } = run({
      folders: inbox(7),
      route: 'kol',
      switches: { shadow_mode: true },
    })
    await sync.sync()
    expect(writer.calls).toEqual([])
  })

  it('挪信关、标已读关：各自生效', async () => {
    const noMove = run({ folders: inbox(7), route: 'support', switches: { move: false } })
    await noMove.sync.sync()
    expect(noMove.writer.calls).toEqual(['flag INBOX/7 +\\Seen'])
    const noRead = run({ folders: inbox(7), route: 'support', switches: { mark_read: false } })
    await noRead.sync.sync()
    expect(noRead.writer.calls).toEqual(['move INBOX/7 → KefuAgents'])
  })

  it('那一侧没接：不动，记「跳过 handoff_refused」', async () => {
    const { sync, writer, log } = run({ folders: inbox(7), route: 'support', handoff: false })
    await sync.sync()
    expect(writer.calls).toEqual([])
    expect(log).toEqual([
      expect.objectContaining({ action: 'move', status: 'skipped', reason: 'handoff_refused' }),
    ])
  })

  it('挪不动：记「失败」，信留在收件箱', async () => {
    const r = run({ folders: inbox(7), route: 'support' })
    r.writer.move_ok = false
    await r.sync.sync()
    expect(r.log.at(-1)).toMatchObject({
      action: 'move',
      status: 'failed',
      reason: 'server_refused',
    })
    expect((await r.store.list({}))[0]?.folder).toBe('INBOX')
  })

  it('已在岗位文件夹里的信不再自动挪（KefuAgents ↔ KOLAgents 不来回挪）', async () => {
    const r = run({
      folders: { KefuAgents: [{ uid: 3, mailbox: 'KefuAgents', source: mime(3) }] },
      route: 'kol',
    })
    await r.sync.sync()
    expect(r.writer.calls).toEqual([])
    expect(r.log).toEqual([])
  })
})
