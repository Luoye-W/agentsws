/**
 * WP161（Luoye 09-27）：岗位文件夹与老产品同名（`KefuAgents` / `KOLAgents`，预留
 * `BtoBAgents`），**认已有文件夹不分大小写**。
 *
 * 事故形态：很多 IMAP 服务器文件夹名区分大小写。用过老产品（或 agentsws 早先全小写
 * `kefuagents`）的人接进来，要是我们照规范名另建一只，邮箱里就有两只相近的文件夹、
 * 信分在两处。全部用替身，不联网。
 */
import type { Clock, MessageRecord, MessageTriage } from '@agentsws/contracts'
import { BTOBAGENTS_FOLDER, KOL_FOLDER, SUPPORT_FOLDER } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  agentFolderVariants,
  allowedRoutes,
  allowRoute,
  EmailChannelAdapter,
  folderPathFor,
  MailboxSync,
  type MailboxWriter,
  type MailSource,
  MemoryMailboxStateStore,
  MemoryMessageStore,
  MemoryRawStore,
  mailboxFoldersFrom,
  matchFolderName,
  type RawEmailMessage,
  resolveAgentFolder,
} from '../src/index.js'

const T0 = '2026-09-27T02:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }

describe('规范名（与老产品逐字相同）', () => {
  it('KefuAgents / KOLAgents / BtoBAgents', () => {
    expect(SUPPORT_FOLDER).toBe('KefuAgents')
    expect(KOL_FOLDER).toBe('KOLAgents')
    expect(BTOBAGENTS_FOLDER).toBe('BtoBAgents')
  })
})

describe('认已有文件夹不分大小写（纯函数）', () => {
  it('只有小写旧文件夹 → 沿用小写，不另建', () => {
    const known = ['INBOX', 'Sent', 'kefuagents', 'kolagents']
    expect(resolveAgentFolder('support', known)).toBe('kefuagents')
    expect(resolveAgentFolder('kol', known)).toBe('kolagents')
    expect(folderPathFor('support', known)).toBe('kefuagents')
  })

  it('只有规范名 → 用规范名', () => {
    const known = ['INBOX', 'KefuAgents', 'KOLAgents']
    expect(folderPathFor('support', known)).toBe('KefuAgents')
    expect(folderPathFor('kol', known)).toBe('KOLAgents')
  })

  it('都没有 → 规范名（第一次挪信时新建）', () => {
    expect(folderPathFor('support', ['INBOX'])).toBe('KefuAgents')
    expect(folderPathFor('kol', [])).toBe('KOLAgents')
    expect(folderPathFor('b2b', ['INBOX'])).toBe('BtoBAgents')
  })

  it('多个变体并存 → 优先规范名；变体全扫（规范名排前），谁都不动', () => {
    const known = ['INBOX', 'kefuagents', 'KEFUAGENTS', 'KefuAgents']
    expect(folderPathFor('support', known)).toBe('KefuAgents')
    expect(agentFolderVariants('support', known)).toEqual([
      'KefuAgents',
      'kefuagents',
      'KEFUAGENTS',
    ])
    // 没有规范名时挑第一个变体，不是随便哪个
    expect(resolveAgentFolder('support', ['INBOX', 'KEFUAGENTS', 'kefuagents'])).toBe('KEFUAGENTS')
  })

  it('任意名字也能认（归档文件夹用这一条）', () => {
    expect(matchFolderName('agentsws', ['INBOX', 'AgentsWS'])).toBe('AgentsWS')
    expect(matchFolderName('agentsws', ['INBOX'])).toBeUndefined()
  })
})

describe('扫描清单按服务器上真有的排', () => {
  it('Gmail 式真名按语义认；岗位文件夹每个变体都扫', () => {
    const listed = [
      'INBOX',
      '[Gmail]/Sent Mail',
      '[Gmail]/Drafts',
      '[Gmail]/Trash',
      '[Gmail]/Spam',
      '[Gmail]/All Mail',
      'kefuagents',
      'KefuAgents',
      'KOLAgents',
      'Project X',
    ]
    expect(mailboxFoldersFrom(listed)).toEqual([
      'INBOX',
      '[Gmail]/Sent Mail',
      '[Gmail]/Drafts',
      '[Gmail]/Trash',
      '[Gmail]/Spam',
      'KefuAgents',
      'kefuagents',
      'KOLAgents',
    ])
  })

  it('岗位文件夹一只都没有就先不扫；BtoBAgents 不在缺省扫描里（预留）', () => {
    expect(mailboxFoldersFrom(['INBOX', 'Sent', 'BtoBAgents'])).toEqual(['INBOX', 'Sent'])
  })

  it('列不到（空清单）→ undefined，调用方退回缺省名单', () => {
    expect(mailboxFoldersFrom([])).toBeUndefined()
    expect(mailboxFoldersFrom(undefined)).toBeUndefined()
  })
})

describe('B2B 只预留：分拣器不产出它', () => {
  const ctx = {
    support_enabled: true,
    kol_enabled: true,
    isSupportThread: () => false,
    isKolThread: () => false,
    senderRules: [],
    model_halted: false,
    at: T0,
  }
  it('b2b 降回收件箱，可选路由里也没有它', () => {
    expect(allowRoute('b2b', ctx)).toBe('inbox')
    expect(allowedRoutes(ctx)).not.toContain('b2b')
  })
})

/* ── 同步：每个邮箱账号各自一套 ─────────────────────────────────────────── */

const mime = (n: number, to: string): string =>
  [
    'From: ann@customer.example',
    `To: ${to}`,
    `Subject: letter ${n}`,
    `Message-ID: <wp161-${n}@mail.example>`,
    'Date: Sun, 27 Sep 2026 01:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
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

class FakeWriter implements MailboxWriter {
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

const verdict = (route: MessageTriage['route']): MessageTriage => ({
  route,
  labels: [],
  needs_reply: true,
  priority: 'normal',
  summary: '岗位信',
  confidence: 0.95,
  by: 'model',
  reasons: [],
  at: T0,
})

/** 一只邮箱：地址、服务器上列出来的文件夹、INBOX 里的信、回写端。 */
interface Box {
  address: string
  listed: string[]
  inbox: RawEmailMessage[]
  writer: FakeWriter
}

const box = (address: string, listed: string[], uid: number): Box => ({
  address,
  listed,
  inbox: [{ uid, mailbox: 'INBOX', source: mime(uid, address) }],
  writer: new FakeWriter(),
})

function syncOf(
  boxes: Box[],
  route: (r: MessageRecord) => MessageTriage['route'],
  errors: unknown[] = [],
): { sync: MailboxSync; store: MemoryMessageStore } {
  const store = new MemoryMessageStore()
  const sync = new MailboxSync({
    clock,
    workspace_id: 'ws_1',
    store,
    state: new MemoryMailboxStateStore(),
    accounts: () =>
      boxes.map((b) => ({
        address: b.address,
        folders: mailboxFoldersFrom(b.listed) ?? ['INBOX'],
        known_folders: b.listed,
        open: (folder: string) => new FolderSource(folder === 'INBOX' ? b.inbox : []),
        writer: b.writer,
      })),
    triage: async (r) => verdict(route(r)),
    handoff: async () => true,
    on_error: (e) => errors.push(e),
  })
  return { sync, store }
}

describe('同步挪信：每个邮箱账号各认各的真名', () => {
  it('两只邮箱：一只沿用小写旧文件夹、一只新建规范名', async () => {
    const legacy = box('old@shop.example', ['INBOX', 'kefuagents', 'kolagents'], 1)
    const fresh = box('new@shop.example', ['INBOX', 'Sent'], 2)
    const { sync, store } = syncOf([legacy, fresh], () => 'support')
    const report = await sync.sync()
    expect(report.moved).toBe(2)
    expect(legacy.writer.moves).toEqual([{ folder: 'INBOX', uid: 1, to: 'kefuagents' }])
    expect(fresh.writer.moves).toEqual([{ folder: 'INBOX', uid: 2, to: 'KefuAgents' }])
    const rows = await store.list({ folder_kind: 'support' })
    expect(rows.map((r) => r.folder).sort()).toEqual(['KefuAgents', 'kefuagents'])
  })

  it('红人信：已有规范名 KOLAgents 就用它（小写变体并存也不挪那边的信）', async () => {
    const both = box('kol@shop.example', ['INBOX', 'kolagents', 'KOLAgents'], 3)
    const { sync } = syncOf([both], () => 'kol')
    await sync.sync()
    expect(both.writer.moves).toEqual([{ folder: 'INBOX', uid: 3, to: 'KOLAgents' }])
  })

  it('MOVE 失败只 log，信仍在消息里可见（63 §5 原规矩）', async () => {
    const legacy = box('old@shop.example', ['INBOX', 'kefuagents'], 4)
    legacy.writer.ok = false
    const errors: unknown[] = []
    const { sync, store } = syncOf([legacy], () => 'support', errors)
    const report = await sync.sync()
    expect(report.moved).toBe(0)
    expect(String(errors[0])).toContain('INBOX → kefuagents')
    const rows = await store.list({})
    expect(rows).toHaveLength(1)
    expect(rows[0]?.folder).toBe('INBOX')
  })
})

/* ── 归档文件夹（48 §4 L3 #5）也认已有的真名 ─────────────────────────────── */

class ArchiveSource implements MailSource {
  readonly archived: { uid: number; folder: string }[] = []
  lists = 0
  constructor(
    private readonly listed: string[],
    private readonly messages: RawEmailMessage[],
  ) {}
  async fetchSince(since: number): Promise<RawEmailMessage[]> {
    return this.messages.filter((m) => m.uid > since)
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async listFolders(): Promise<string[]> {
    this.lists += 1
    return this.listed
  }
  async archive(uid: number, folder: string): Promise<boolean> {
    this.archived.push({ uid, folder })
    return true
  }
}

function archiver(source: MailSource, address: string): EmailChannelAdapter {
  return new EmailChannelAdapter({
    clock,
    rawStore: new MemoryRawStore({ clock }),
    address,
    source,
    mailbox_state: new MemoryMailboxStateStore(),
    scan_owner: 'proc_a',
    archive_folder: SUPPORT_FOLDER,
  })
}

const inbox = (address: string, uids: number[]): RawEmailMessage[] =>
  uids.map((uid) => ({ uid, mailbox: 'INBOX', source: mime(uid, address) }))

describe('归档文件夹：每只邮箱认各自已有的那只', () => {
  it('只有小写 kefuagents → 归档进它，不另建 KefuAgents；清单只列一次', async () => {
    const source = new ArchiveSource(['INBOX', 'kefuagents'], inbox('a@shop.example', [1, 2]))
    await archiver(source, 'a@shop.example').poll(async () => undefined)
    expect(source.archived).toEqual([
      { uid: 1, folder: 'kefuagents' },
      { uid: 2, folder: 'kefuagents' },
    ])
    expect(source.lists).toBe(1)
  })

  it('都没有 → 规范名 KefuAgents；列不到 → 按配置名走', async () => {
    const fresh = new ArchiveSource(['INBOX'], inbox('b@shop.example', [1]))
    await archiver(fresh, 'b@shop.example').poll(async () => undefined)
    expect(fresh.archived).toEqual([{ uid: 1, folder: 'KefuAgents' }])

    const blind = new ArchiveSource([], inbox('c@shop.example', [1]))
    await archiver(blind, 'c@shop.example').poll(async () => undefined)
    expect(blind.archived).toEqual([{ uid: 1, folder: 'KefuAgents' }])
  })
})
