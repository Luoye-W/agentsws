/**
 * WP161（Luoye 09-27）：服务进程里**每只邮箱先列文件夹**，岗位文件夹认已有的真名
 * （不分大小写），都没有才按规范名 `KefuAgents` / `KOLAgents` 新建。
 *
 * 全程替身：收信端是内存 `MailSource`，回写端记录每一次 MOVE，文件夹清单由
 * `listFolders` 注入。不连任何真邮箱。
 */
import type { MailboxWriter, MailSource, RawEmailMessage } from '@agentsws/channels'
import type { Clock, EventEnvelope } from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import { createWork } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import type { MailAccount } from '../src/index.js'
import { createMessages, DEFAULT_FOLDERS, FOLDER_LIST_TTL_MS } from '../src/messages.js'

const WS = 'ws_1'
const T0 = '2026-09-27T02:00:00.000Z'
const ACTOR = { workspace_id: WS, person_id: 'p_owner', assignment_id: 'asg_1' }
const CUSTOMER = 'ann@customer.example'

const accountOf = (id: string, address: string): MailAccount => ({
  connection_id: id,
  address,
  imap: { host: 'localhost', port: 143, secure: false, user: address, connection_id: id },
  smtp: { host: 'localhost', port: 25, secure: false, user: address, connection_id: id },
})

const mime = (uid: number, to: string): string =>
  [
    `From: ${CUSTOMER}`,
    `To: ${to}`,
    `Subject: 包裹破了 ${uid}`,
    `Message-ID: <wp161-${to}-${uid}@mail.example>`,
    'Date: Sun, 27 Sep 2026 01:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '包裹破了，要退款',
    '',
  ].join('\r\n')

class FolderSource implements MailSource {
  constructor(private readonly rows: RawEmailMessage[]) {}
  async fetchSince(since: number): Promise<RawEmailMessage[]> {
    return this.rows.filter((r) => r.uid > since)
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
}

class RecordingWriter implements MailboxWriter {
  readonly moves: { folder: string; uid: number; to: string }[] = []
  ok = true
  setFlags(): boolean {
    return true
  }
  move(folder: string, uid: number, to: string): boolean {
    if (!this.ok) return false
    this.moves.push({ folder, uid, to })
    return true
  }
}

/** 一只邮箱：服务器上列出来的文件夹（`undefined` = 列的时候抛）、INBOX 里的信。 */
interface Box {
  account: MailAccount
  listed: string[] | undefined
  inbox: RawEmailMessage[]
  writer: RecordingWriter
  lists: number
  scanned: Set<string>
}

const box = (id: string, address: string, listed: string[] | undefined, uid = 1): Box => ({
  account: accountOf(id, address),
  listed,
  inbox: [{ uid, mailbox: 'INBOX', source: mime(uid, address) }],
  writer: new RecordingWriter(),
  lists: 0,
  scanned: new Set(),
})

function setup(boxes: Box[], now: { t: string } = { t: T0 }) {
  const events: EventEnvelope[] = []
  const clock: Clock = { now: () => now.t, sleep: async () => undefined }
  const byId = new Map(boxes.map((b) => [b.account.connection_id, b]))
  const get = (a: MailAccount): Box => byId.get(a.connection_id) as Box
  const messages = createMessages({
    clock,
    workspace_id: WS,
    appendEvent: (e) => {
      events.push(e as EventEnvelope)
    },
    halt: new MemoryHalt({}),
    accounts: () => boxes.map((b) => b.account),
    credentials: { password: () => 'pw' },
    work: createWork({ workspace_id: WS, clock, random: () => 0.5 }),
    position: () => ({ person_id: 'p_owner', assignment_id: 'asg_1', role_id: 'dtc.support' }),
    activeRoles: () => ['dtc.support'],
    makeSource: (a, folder) => {
      get(a).scanned.add(folder)
      return new FolderSource(folder === 'INBOX' ? get(a).inbox : [])
    },
    makeWriter: (a) => get(a).writer,
    listFolders: async (a) => {
      const b = get(a)
      b.lists += 1
      if (b.listed === undefined) throw new Error('LIST 被拒')
      return b.listed
    },
  })
  return { messages, events }
}

/** 教一条"这个发件人归客服"的规则：分拣走第 ② 层，不用模型桩。 */
async function teachSupport(messages: ReturnType<typeof createMessages>['store']) {
  await messages.putSenderRule({
    id: 'rule_1',
    sender: CUSTOMER,
    route: 'support',
    labels: [],
    by: 'p_owner',
    created_at: T0,
  })
}

describe('WP161：每只邮箱先列文件夹，岗位文件夹认已有真名', () => {
  it('只有小写旧文件夹 → 沿用小写、不新建；它也在扫描清单里', async () => {
    const legacy = box('conn_a', 'old@shop.example', ['INBOX', 'Sent', 'kefuagents'])
    const { messages } = setup([legacy])
    await teachSupport(messages.store)
    const report = await messages.poll()
    expect(report.moved).toBe(1)
    expect(legacy.writer.moves).toEqual([{ folder: 'INBOX', uid: 1, to: 'kefuagents' }])
    expect([...legacy.scanned].sort()).toEqual(['INBOX', 'Sent', 'kefuagents'])
    expect((await messages.store.list({}))[0]?.folder).toBe('kefuagents')
  })

  it('只有规范名 → 用规范名', async () => {
    const canon = box('conn_a', 'a@shop.example', ['INBOX', 'KefuAgents', 'KOLAgents'])
    const { messages } = setup([canon])
    await teachSupport(messages.store)
    await messages.poll()
    expect(canon.writer.moves).toEqual([{ folder: 'INBOX', uid: 1, to: 'KefuAgents' }])
  })

  it('都没有 → 新建规范名；新建之后下一轮就扫它，清单在有效期内不重列', async () => {
    const fresh = box('conn_a', 'new@shop.example', ['INBOX'])
    const { messages } = setup([fresh])
    await teachSupport(messages.store)
    await messages.poll()
    expect(fresh.writer.moves).toEqual([{ folder: 'INBOX', uid: 1, to: 'KefuAgents' }])
    expect(fresh.scanned.has('KefuAgents')).toBe(false)
    await messages.poll()
    expect(fresh.scanned.has('KefuAgents')).toBe(true)
    expect(fresh.lists).toBe(1)
  })

  it('两个邮箱账号各自一套：一只沿用小写、一只新建规范名；各列各的', async () => {
    const legacy = box('conn_a', 'old@shop.example', ['INBOX', 'kefuagents'], 1)
    const fresh = box('conn_b', 'new@shop.example', ['INBOX'], 2)
    const { messages } = setup([legacy, fresh])
    await teachSupport(messages.store)
    await messages.poll()
    expect(legacy.writer.moves).toEqual([{ folder: 'INBOX', uid: 1, to: 'kefuagents' }])
    expect(fresh.writer.moves).toEqual([{ folder: 'INBOX', uid: 2, to: 'KefuAgents' }])
    expect([legacy.lists, fresh.lists]).toEqual([1, 1])
  })

  it('清单过期才重列', async () => {
    const now = { t: T0 }
    const a = box('conn_a', 'a@shop.example', ['INBOX'])
    const { messages } = setup([a], now)
    await messages.poll()
    await messages.poll()
    expect(a.lists).toBe(1)
    now.t = new Date(Date.parse(T0) + FOLDER_LIST_TTL_MS + 1).toISOString()
    await messages.poll()
    expect(a.lists).toBe(2)
  })

  it('列不到 → 按缺省名单扫、挪进规范名；日志里没有完整地址；下一轮再列', async () => {
    const blind = box('conn_a', 'blind@shop.example', undefined)
    const { messages, events } = setup([blind])
    await teachSupport(messages.store)
    await messages.poll()
    expect([...blind.scanned].sort()).toEqual([...DEFAULT_FOLDERS].sort())
    expect(DEFAULT_FOLDERS).toContain('KefuAgents')
    expect(DEFAULT_FOLDERS).toContain('KOLAgents')
    expect(blind.writer.moves).toEqual([{ folder: 'INBOX', uid: 1, to: 'KefuAgents' }])
    const logged = JSON.stringify(events.map((e) => e.payload))
    expect(logged).toContain('imap_list_failed')
    expect(logged).not.toContain('blind@shop.example')
    await messages.poll()
    expect(blind.lists).toBe(2)
  })

  it('MOVE 失败只 log，信仍在收件箱里可见（63 §5 原规矩）', async () => {
    const legacy = box('conn_a', 'old@shop.example', ['INBOX', 'kefuagents'])
    legacy.writer.ok = false
    const { messages, events } = setup([legacy])
    await teachSupport(messages.store)
    const report = await messages.poll()
    expect(report.moved).toBe(0)
    const rows = await messages.store.list({})
    expect(rows).toHaveLength(1)
    expect(rows[0]?.folder).toBe('INBOX')
    expect(JSON.stringify(events.map((e) => e.payload))).toContain('message_sync_failed')
  })

  it('人手动「移到客服」也按这只邮箱的真名走', async () => {
    const legacy = box('conn_a', 'old@shop.example', ['INBOX', 'kefuagents'])
    const { messages } = setup([legacy])
    await messages.poll()
    const row = (await messages.store.list({}))[0]
    expect(row?.folder).toBe('INBOX')
    const moved = await messages.port.move(ACTOR, row?.id ?? '', { to: 'support' })
    expect(moved.message.folder).toBe('kefuagents')
    expect(legacy.writer.moves.at(-1)).toEqual({ folder: 'INBOX', uid: 1, to: 'kefuagents' })
  })
})
