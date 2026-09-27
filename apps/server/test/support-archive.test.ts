/**
 * WP163：客服收信只把「判成客服的信」挪进 KefuAgents，而且同一只邮箱**只有一处**在挪。
 *
 * 两条收信路共用一只替身邮箱（内存里的文件夹 → 信），按服务进程里调度器的顺序跑：
 * 先 `channels.poll()`（渠道那一路），再 `messages.poll()`（消息同步）。不联网。
 */
import type { MailboxWriter, MailSource } from '@agentsws/channels'
import type { Clock, EventEnvelope, ModelGateway, RoleId } from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import { createWork } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import { createChannels } from '../src/channels.js'
import type { MailAccount } from '../src/index.js'
import { createMessages } from '../src/messages.js'

const WS = 'ws_1'
const ME = 'hello@shop.example'
const T0 = '2026-09-27T02:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }
const account: MailAccount = {
  connection_id: 'conn_mail',
  address: ME,
  imap: { host: 'localhost', port: 143, secure: false, user: ME, connection_id: 'conn_mail' },
  smtp: { host: 'localhost', port: 25, secure: false, user: ME, connection_id: 'conn_mail' },
}

const mime = (uid: number, from: string, headers: string[] = []): string =>
  [
    `From: ${from}`,
    `To: ${ME}`,
    `Subject: letter ${uid}`,
    `Message-ID: <m-${uid}@mail.example>`,
    'Date: Sat, 26 Sep 2026 10:00:00 +0000',
    ...headers,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `body ${uid}`,
    '',
  ].join('\r\n')

/** 一只替身邮箱：文件夹 → 信（带 flags）。两条路都在它上面读写。 */
class Mailbox {
  readonly folders = new Map<string, { uid: number; source: string; flags: Set<string> }[]>([
    ['INBOX', []],
  ])
  readonly moves: string[] = []
  move_ok = true
  private next = 100
  deliver(uid: number, source: string): void {
    this.folders.get('INBOX')?.push({ uid, source, flags: new Set() })
  }
  where(uid: number): { folder: string; read: boolean } | undefined {
    for (const [folder, rows] of this.folders) {
      const row = rows.find((r) => r.source.includes(`<m-${uid}@`))
      if (row !== undefined) return { folder, read: row.flags.has('\\Seen') }
    }
    return undefined
  }
  source(folder: string): MailSource {
    return {
      fetchSince: async (since) =>
        (this.folders.get(folder) ?? [])
          .filter((r) => r.uid > since)
          .map((r) => ({ uid: r.uid, mailbox: folder, source: r.source })),
      health: async () => ({ ok: true }),
      listFolders: async () => [...this.folders.keys()],
      archive: async (uid, to, mark_read) => {
        if (mark_read) this.flag(folder, uid)
        return this.moveOne(folder, uid, to)
      },
      markRead: async (uid) => this.flag(folder, uid),
    }
  }
  writer(): MailboxWriter {
    return {
      setFlags: (folder, uid, add) => (add.includes('\\Seen') ? this.flag(folder, uid) : true),
      move: (folder, uid, to) => this.moveOne(folder, uid, to),
      listFolders: () => [...this.folders.keys()],
    }
  }
  private flag(folder: string, uid: number): boolean {
    const row = this.folders.get(folder)?.find((r) => r.uid === uid)
    row?.flags.add('\\Seen')
    return row !== undefined
  }
  private moveOne(folder: string, uid: number, to: string): boolean {
    if (!this.move_ok) return false
    const rows = this.folders.get(folder) ?? []
    const at = rows.findIndex((r) => r.uid === uid)
    const row = rows[at]
    if (row === undefined) return false
    rows.splice(at, 1)
    const dest = this.folders.get(to) ?? []
    this.folders.set(to, dest)
    // IMAP：挪过去的信在目标文件夹里拿一个新 UID
    this.next += 1
    dest.push({ ...row, uid: this.next })
    this.moves.push(`${folder}/${uid} → ${to}`)
    return true
  }
}

/** 模型桩：走到模型这一层的信一律判成客服（群发信在第 ③ 层就被规则拦下，不花模型）。 */
const supportModel = {
  async complete() {
    return {
      text: JSON.stringify({
        route: 'support',
        labels: [],
        needs_reply: true,
        priority: 'high',
        summary: '客户问包裹',
        confidence: 0.95,
      }),
      usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
      model: { provider: 'stub', model: 'stub' },
      static_prefix_hash: '',
    }
  },
} as unknown as ModelGateway

const NEWSLETTER = ['List-Unsubscribe: <mailto:unsub@news.example>']

function assemble(over: {
  box: Mailbox
  moves: 'channel' | 'message_sync'
  roles?: RoleId[]
  withMessages?: boolean
  supportEnabled?: boolean
}) {
  const events: EventEnvelope[] = []
  const appendEvent = (e: unknown): void => void events.push(e as EventEnvelope)
  const work = createWork({ workspace_id: WS, clock, random: () => 0.5 })
  const position = () => ({ person_id: 'p_owner', assignment_id: 'asg_1', role_id: 'dtc.support' })
  const channels = createChannels({
    clock,
    workspace_id: WS,
    appendEvent,
    halt: new MemoryHalt({}),
    accounts: () => [account],
    credentials: { password: () => 'pw' },
    work,
    position,
    makeSource: () => over.box.source('INBOX'),
    mailbox_moves: over.moves,
    // 渠道那一路没有分拣：用路由把群发信分到别的岗位上，看它挪不挪
    route: (input) =>
      input.actor_external_id?.endsWith('@news.example') === true
        ? { role_id: 'common.member', confidence: 1 }
        : undefined,
    ...(over.supportEnabled === undefined
      ? {}
      : { supportEnabled: () => over.supportEnabled === true }),
  })
  const messages =
    over.withMessages === false
      ? undefined
      : createMessages({
          clock,
          workspace_id: WS,
          appendEvent,
          halt: new MemoryHalt({}),
          accounts: () => [account],
          credentials: { password: () => 'pw' },
          work,
          position,
          activeRoles: () => over.roles ?? ['dtc.support'],
          models: supportModel,
          makeSource: (_a, folder) => over.box.source(folder),
          makeWriter: () => over.box.writer(),
          listFolders: async () => [...over.box.folders.keys()],
        })
  /** 服务进程调度器的一拍：先渠道、再消息同步（server.ts 的 registerMailPoll）。 */
  const tick = async (): Promise<void> => {
    await channels.poll()
    await messages?.poll()
  }
  const actions = () => events.filter((e) => e.type === 'inbound.mailbox_action')
  return { channels, messages, tick, events, actions }
}

describe('WP163：挪信只由一处负责（服务进程的装配）', () => {
  it('群发信原地不动、不标已读；客服信只被消息同步挪一次，两拍之后也不来回挪', async () => {
    const box = new Mailbox()
    box.deliver(1, mime(1, 'promo@news.example', NEWSLETTER))
    box.deliver(2, mime(2, 'ann@customer.example'))
    const h = assemble({ box, moves: 'message_sync' })
    await h.tick()
    await h.tick()
    expect(box.where(1)).toEqual({ folder: 'INBOX', read: false })
    expect(box.where(2)).toEqual({ folder: 'KefuAgents', read: true })
    expect(box.moves).toEqual(['INBOX/2 → KefuAgents'])
    // 渠道那一路一笔都没记（它不动邮箱）；消息同步记了标已读 + 挪信
    const acts = h.actions()
    expect(acts.every((e) => e.actor.id === 'messages')).toBe(true)
    expect(acts.map((e) => (e.payload as { action: string }).action)).toEqual(['mark_read', 'move'])
    // 事件里没有正文，地址是遮过的
    expect(JSON.stringify(acts)).not.toContain('body 2')
    expect(JSON.stringify(acts)).not.toContain(ME)
  })

  it('只装渠道（渠道负责挪信）：只挪进了客服路由、建了客服线程的那封', async () => {
    const box = new Mailbox()
    box.deliver(1, mime(1, 'promo@news.example', NEWSLETTER))
    box.deliver(2, mime(2, 'ann@customer.example'))
    const h = assemble({ box, moves: 'channel', withMessages: false })
    await h.tick()
    expect(box.where(1)).toEqual({ folder: 'INBOX', read: false })
    expect(box.where(2)).toEqual({ folder: 'KefuAgents', read: true })
    expect(h.actions().every((e) => e.actor.id === 'channel:email')).toBe(true)
  })

  it('只装渠道、客服岗位关着：一封都不挪，记「跳过」', async () => {
    const box = new Mailbox()
    box.deliver(2, mime(2, 'ann@customer.example'))
    const h = assemble({ box, moves: 'channel', withMessages: false, supportEnabled: false })
    await h.tick()
    expect(box.where(2)).toEqual({ folder: 'INBOX', read: false })
    expect(h.actions().map((e) => e.payload)).toEqual([
      expect.objectContaining({ action: 'move', status: 'skipped', reason: 'handoff_refused' }),
    ])
  })

  it('挪不动：「消息」页那只邮箱上看得到最近一次失败的原因码；后来挪成了就不再挂着', async () => {
    const box = new Mailbox()
    box.move_ok = false
    box.deliver(2, mime(2, 'ann@customer.example'))
    const h = assemble({ box, moves: 'message_sync' })
    await h.tick()
    const actor = { workspace_id: WS, person_id: 'p_owner', assignment_id: 'asg_1' }
    const view = (await h.messages?.port.accounts(actor))?.accounts[0]
    expect(view?.last_mailbox_failure).toMatchObject({
      action: 'move',
      reason: 'server_refused',
      folder: 'INBOX',
      to_folder: 'KefuAgents',
    })
    box.move_ok = true
    box.deliver(3, mime(3, 'bob@customer.example'))
    await h.tick()
    const after = (await h.messages?.port.accounts(actor))?.accounts[0]
    expect(after?.last_mailbox_failure).toBeUndefined()
  })
})
