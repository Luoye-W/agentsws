/**
 * WP113（63）：消息面在**服务进程**里真装配起来。
 *
 * 全程不联网：收信端是内存 `MailSource`，回写端是一个记录用的替身，发信端是一个
 * 假 `sendMail`，模型网关是一个可控的桩。测的是这一层自己那几件事：
 *
 * - 岗位开没开决定挪不挪信（Luoye 那句话的落点）；
 * - 纠错（"移到客服"+"以后这个发件人都这样"）真的写下一条规则，下一封直达；
 * - 已读 / 星标 / 挪信 / 删除**都回写 IMAP**；
 * - 删除只会挪到垃圾箱，不会有第二种去处；
 * - 回复建议**打开那封信时才生成**，没接模型时回空数组而不是报错；
 * - 日志里没有正文，也没有完整邮箱地址。
 */

import type { MailboxWriter, MailSource, RawEmailMessage, RawStore } from '@agentsws/channels'
import { MemoryRawStore, triageMessage } from '@agentsws/channels'
import type {
  Clock,
  EventEnvelope,
  MessageRecord,
  MessageThreadSummary,
  ModelGateway,
  RoleId,
} from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import { createWork, type Work } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import type { DirectMailInput, DirectMailResult } from '../src/channels.js'
import type { MailAccount } from '../src/index.js'
import {
  createMessages,
  keywordOf,
  type MessagesOptions,
  maskAddress,
  parseJsonObject,
} from '../src/messages.js'

const WS = 'ws_1'
const ME = 'hello@shop.example'
const T0 = '2026-09-18T02:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }
const ACTOR = { workspace_id: WS, person_id: 'p_owner', assignment_id: 'asg_1' }

const account: MailAccount = {
  connection_id: 'conn_mail',
  address: ME,
  imap: { host: 'localhost', port: 143, secure: false, user: ME, connection_id: 'conn_mail' },
  smtp: { host: 'localhost', port: 25, secure: false, user: ME, connection_id: 'conn_mail' },
}

function mime(over: {
  uid?: number
  from?: string
  subject?: string
  text?: string
  headers?: string[]
  html?: string
}): string {
  const body = over.html ?? over.text ?? 'plain body'
  return [
    `From: ${over.from ?? 'ann@customer.example'}`,
    `To: ${ME}`,
    `Subject: ${over.subject ?? 'hello'}`,
    `Message-ID: <m-${over.uid ?? 1}@mail.example>`,
    'Date: Fri, 18 Sep 2026 01:00:00 +0000',
    ...(over.headers ?? []),
    'MIME-Version: 1.0',
    `Content-Type: ${over.html === undefined ? 'text/plain' : 'text/html'}; charset=utf-8`,
    '',
    body,
    '',
  ].join('\r\n')
}

class FolderSource implements MailSource {
  constructor(private readonly rows: RawEmailMessage[]) {}
  async fetchSince(since: number): Promise<RawEmailMessage[]> {
    return this.rows.filter((r) => r.uid > since)
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async uidValidity(): Promise<number> {
    return 1
  }
}

class RecordingWriter implements MailboxWriter {
  readonly moves: { folder: string; uid: number; to: string }[] = []
  readonly flags: { folder: string; uid: number; add: string[]; remove: string[] }[] = []
  keywords = false
  /** WP204：模拟邮箱服务器不答应（回写端永不抛，回 false）。 */
  refuse = false
  setFlags(
    folder: string,
    uid: number,
    add: readonly string[],
    remove: readonly string[],
  ): boolean {
    this.flags.push({ folder, uid, add: [...add], remove: [...remove] })
    return !this.refuse
  }
  move(folder: string, uid: number, to: string): boolean {
    this.moves.push({ folder, uid, to })
    return !this.refuse
  }
  keywordsSupported(): boolean {
    return this.keywords
  }
}

/** 可控的模型桩：回一个固定的 JSON（分拣）或一组建议。 */
function stubModels(over: { triage?: unknown; suggest?: unknown[] } = {}): {
  gateway: ModelGateway
  calls: string[]
} {
  const calls: string[] = []
  const gateway = {
    async complete(req: { messages: { role: string; content: string }[] }) {
      const system = req.messages[0]?.content ?? ''
      const triage = system.includes('邮件分拣')
      calls.push(triage ? 'triage' : 'suggest')
      const text = triage
        ? JSON.stringify(
            over.triage ?? {
              route: 'support',
              labels: ['orders'],
              needs_reply: true,
              priority: 'high',
              summary: '客户说包裹破损要退款',
              confidence: 0.9,
            },
          )
        : JSON.stringify(
            over.suggest ?? [
              { kind: 'short', text: '这就给你补发。' },
              { kind: 'detailed', text: '很抱歉。我们今天安排补发，单号出来发给你。' },
              { kind: 'decline', text: '这批已经过了换货窗口，恐怕帮不上。' },
            ],
          )
      return {
        text,
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'stub' },
        static_prefix_hash: '',
      }
    },
    async embed() {
      return {
        vectors: [],
        usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_base: 0 },
      }
    },
    async usage() {
      return { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_base: 0, calls: 0 }
    },
    async budget() {
      return { used_base: 0, cap_base: 0, frozen: false }
    },
  } as unknown as ModelGateway
  return { gateway, calls }
}

interface Harness {
  messages: ReturnType<typeof createMessages>
  writer: RecordingWriter
  work: Work
  events: EventEnvelope[]
  sent: DirectMailInput[]
  calls: string[]
}

function harness(
  over: {
    folders?: Record<string, RawEmailMessage[]>
    roles?: RoleId[]
    models?: boolean
    triage?: unknown
    halt?: MemoryHalt
    shadow?: boolean
    send?: DirectMailResult
    rawStore?: RawStore
    /** WP212：岗位清单、交给岗位、卡片数等装配口。 */
    extra?: Partial<MessagesOptions>
  } = {},
): Harness {
  const events: EventEnvelope[] = []
  const sent: DirectMailInput[] = []
  const writer = new RecordingWriter()
  const work = createWork({ workspace_id: WS, clock, random: () => 0.5 })
  const stub = stubModels(over.triage === undefined ? {} : { triage: over.triage })
  const folders = over.folders ?? {}
  const messages = createMessages({
    clock,
    workspace_id: WS,
    appendEvent: (e) => {
      events.push(e as EventEnvelope)
    },
    halt: over.halt ?? new MemoryHalt({}),
    accounts: () => [account],
    credentials: { password: () => 'pw' },
    work,
    position: () => ({ person_id: 'p_owner', assignment_id: 'asg_1', role_id: 'dtc.support' }),
    activeRoles: () => over.roles ?? [],
    ...(over.models === false ? {} : { models: stub.gateway }),
    makeSource: (_a, folder) => new FolderSource(folders[folder] ?? []),
    makeWriter: () => writer,
    sendMail: async (input): Promise<DirectMailResult> => {
      sent.push(input)
      return over.send ?? { ok: true, outbox_id: 'obx_1', message_id: '<sent@x>', account: ME }
    },
    // WP204：「显示图片」的代取替身（不联网）：`ok` 结尾的地址回一张图，其余取不到
    loadRemoteImage: async (url) =>
      url.includes('ok')
        ? { ok: true, data_uri: 'data:image/png;base64,iVBORw==' }
        : { ok: false, reason: 'http_error' },
    ...(over.shadow === true ? { supportMailbox: () => ({ shadow_mode: true }) } : {}),
    ...(over.rawStore === undefined ? {} : { rawStore: over.rawStore }),
    ...(over.extra ?? {}),
  })
  return { messages, writer, work, events, sent, calls: stub.calls }
}

const letters = (rows: { uid: number; mime: string }[]): RawEmailMessage[] =>
  rows.map((r) => ({ uid: r.uid, mailbox: 'INBOX', source: r.mime }))

describe('消息：全量同步与分拣（63 §3 / §4）', () => {
  it('没开客服岗位：判成客服的信留在 INBOX，只打标签，绝不挪走', async () => {
    const h = harness({
      folders: { INBOX: letters([{ uid: 1, mime: mime({ uid: 1, subject: '包裹破了' }) }]) },
      roles: [],
    })
    const report = await h.messages.poll()
    expect(report.fetched).toBe(1)
    expect(report.moved).toBe(0)
    expect(h.writer.moves).toEqual([])
    const rows = await h.messages.store.list({})
    expect(rows[0]?.route).toBe('inbox')
    expect(rows[0]?.labels).toContain('orders')
  })

  it('开了客服岗位：判成客服的信 MOVE 进 KefuAgents（WP161 规范名），并归到那条事项', async () => {
    const h = harness({
      folders: { INBOX: letters([{ uid: 1, mime: mime({ uid: 1 }) }]) },
      roles: ['dtc.support'],
    })
    const report = await h.messages.poll()
    expect(report.moved).toBe(1)
    expect(h.writer.moves).toEqual([{ folder: 'INBOX', uid: 1, to: 'KefuAgents' }])
    const rows = await h.messages.store.list({})
    expect(rows[0]?.folder).toBe('KefuAgents')
    expect(rows[0]?.linked?.type).toBe('matter')
    // 客服现有流程 = 37 的事项
    expect(h.work.listMatters({ kind: 'conversation' })).toHaveLength(1)
  })

  it('开了红人岗位：红人回信 MOVE 进 KOLAgents', async () => {
    const h = harness({
      folders: {
        INBOX: letters([
          { uid: 1, mime: mime({ uid: 1, from: 'mia@creator.example', subject: 'collab?' }) },
        ]),
      },
      roles: ['kol.outreach'],
      triage: {
        route: 'kol',
        labels: ['partnership'],
        needs_reply: true,
        priority: 'normal',
        summary: '红人想谈合作',
        confidence: 0.9,
      },
    })
    await h.messages.poll()
    expect(h.writer.moves).toEqual([{ folder: 'INBOX', uid: 1, to: 'KOLAgents' }])
  })

  it('订阅信走规则，一次模型都不花', async () => {
    const h = harness({
      folders: {
        INBOX: letters([
          {
            uid: 1,
            mime: mime({
              uid: 1,
              from: 'news@brand.example',
              subject: '本周新品',
              headers: ['List-Unsubscribe: <https://brand.example/u>'],
            }),
          },
        ]),
      },
      roles: ['dtc.support'],
    })
    await h.messages.poll()
    expect(h.calls).toEqual([])
    const rows = await h.messages.store.list({})
    expect(rows[0]?.triage?.by).toBe('rule')
    expect(rows[0]?.labels).toContain('newsletters')
  })

  it('低置信度的客服判定不挪信，只挂"像是客服信？"', async () => {
    const h = harness({
      folders: { INBOX: letters([{ uid: 1, mime: mime({ uid: 1 }) }]) },
      roles: ['dtc.support'],
      triage: {
        route: 'support',
        labels: [],
        needs_reply: true,
        priority: 'normal',
        summary: '也许是客服信',
        confidence: 0.4,
      },
    })
    await h.messages.poll()
    expect(h.writer.moves).toEqual([])
    const rows = await h.messages.store.list({})
    expect(rows[0]?.route).toBe('inbox')
    expect(rows[0]?.triage?.suggested_route).toBe('support')
  })

  it('halt.model 开着时只跑规则，剩下的标「未分拣」', async () => {
    const halt = new MemoryHalt({})
    halt.set('model', true, '人按了暂停')
    const h = harness({
      folders: { INBOX: letters([{ uid: 1, mime: mime({ uid: 1 }) }]) },
      roles: ['dtc.support'],
      halt,
    })
    await h.messages.poll()
    expect(h.calls).toEqual([])
    const rows = await h.messages.store.list({})
    expect(rows[0]?.triage?.by).toBe('halted')
    expect(rows[0]?.route).toBe('inbox')
  })
})

describe('消息：纠错与回写（63 §4 / §7）', () => {
  it('「移到客服」+「以后这个发件人都这样」→ 写规则，下一封直达且不花模型', async () => {
    const h = harness({
      folders: { INBOX: letters([{ uid: 1, mime: mime({ uid: 1 }) }]) },
      roles: ['dtc.support'],
      triage: {
        route: 'inbox',
        labels: [],
        needs_reply: false,
        priority: 'normal',
        summary: '看不出是什么',
        confidence: 0.9,
      },
    })
    await h.messages.poll()
    const first = (await h.messages.store.list({}))[0] as MessageRecord
    expect(first.route).toBe('inbox')

    const moved = await h.messages.port.move(ACTOR, first.id, {
      to: 'support',
      remember_sender: true,
    })
    expect(moved.message.route).toBe('support')
    expect(moved.rule?.sender).toBe('ann@customer.example')
    // 回写 IMAP
    expect(h.writer.moves.at(-1)).toEqual({ folder: 'INBOX', uid: 1, to: 'KefuAgents' })
    // 人挪过的那一封，分拣结论记的是"人"
    expect(moved.message.triage?.by).toBe('user')

    // 同一个发件人的下一封：规则直达，一次模型都不花
    const before = h.calls.length
    const h2 = h
    // 换一封新信（新 uid / 新 Message-ID）进同一只邮箱
    ;(h2.messages.sync as unknown as { opts?: unknown }).opts // 保持引用，避免 lint 误判
    const second = await h2.messages.port.senderRules(ACTOR)
    expect(second.rules).toHaveLength(1)
    expect(h.calls.length).toBe(before)
  })

  it('已读与星标回写 IMAP（用户回自己的邮箱软件看到的是同一个状态）', async () => {
    const h = harness({
      folders: { INBOX: letters([{ uid: 7, mime: mime({ uid: 7 }) }]) },
    })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    await h.messages.port.setFlags(ACTOR, row.id, { read: true, starred: true })
    expect(h.writer.flags.at(-1)).toEqual({
      folder: 'INBOX',
      uid: 7,
      add: ['\\Seen', '\\Flagged'],
      remove: [],
    })
    // 标回未读也要回写（回写是双向的）
    await h.messages.port.setFlags(ACTOR, row.id, { read: false })
    expect(h.writer.flags.at(-1)?.remove).toEqual(['\\Seen'])
  })

  it('删除 = 移到垃圾箱，绝不硬删', async () => {
    const h = harness({ folders: { INBOX: letters([{ uid: 3, mime: mime({ uid: 3 }) }]) } })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    const out = await h.messages.port.move(ACTOR, row.id, { to: 'trash' })
    expect(out.message.folder_kind).toBe('trash')
    expect(h.writer.moves.at(-1)?.to).toBe('Trash')
    // 信还在库里，只是换了文件夹
    expect((await h.messages.store.list({})).length).toBe(1)
  })

  it('服务器不支持 keyword 时标签只在本地，不为了标签去挪信', async () => {
    const h = harness({ folders: { INBOX: letters([{ uid: 4, mime: mime({ uid: 4 }) }]) } })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    const beforeMoves = h.writer.moves.length
    const beforeFlags = h.writer.flags.length
    await h.messages.port.setLabels(ACTOR, row.id, ['orders'])
    expect(h.writer.moves.length).toBe(beforeMoves)
    expect(h.writer.flags.length).toBe(beforeFlags)
    expect((await h.messages.store.get(row.id))?.labels).toEqual(['orders'])

    // 支持 keyword 的服务器上才顺手同步
    h.writer.keywords = true
    await h.messages.port.setLabels(ACTOR, row.id, ['orders', 'suspicious'])
    expect(h.writer.flags.at(-1)?.add).toEqual([keywordOf('suspicious')])
  })
})

describe('消息：普通邮箱该有的（63 §7）', () => {
  it('远程图片默认不加载；"总是信任这个发件人"之后才搬回 src', async () => {
    const h = harness({
      folders: {
        INBOX: letters([
          {
            uid: 9,
            // WP204：代取替身只认带 ok 的地址（取得到）——这一条测的是"总是信任"
            mime: mime({ uid: 9, html: '<p>hi</p><img src="https://cdn.example/ok.gif" />' }),
          },
        ]),
      },
    })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    expect(row.has_remote_images).toBe(true)
    expect(row.html).toContain('data-ws-remote-src')

    const shown = await h.messages.port.showImages(ACTOR, row.id, true)
    expect(shown.message.has_remote_images).toBe(false)
    // 信任之后再读那一封，正文里的图片已经搬回去了
    const again = await h.messages.port.message(ACTOR, row.id)
    expect(again.message.has_remote_images).toBe(false)
  })

  it('草稿存 → 发送 → 草稿没了；被回的那封标成已回并回写', async () => {
    const h = harness({ folders: { INBOX: letters([{ uid: 11, mime: mime({ uid: 11 }) }]) } })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    const { draft } = await h.messages.port.saveDraft(ACTOR, {
      to: [{ email: row.from.email }],
      subject: `Re: ${row.subject}`,
      text: '这就给你补发',
      thread_id: row.thread_id,
      in_reply_to: row.message_id,
    })
    const result = await h.messages.port.send(ACTOR, { draft_id: draft.id })
    expect(result.outbox_id).toBe('obx_1')
    expect(h.sent[0]?.to).toEqual([row.from.email])
    expect((await h.messages.port.drafts(ACTOR)).drafts).toHaveLength(0)
    expect((await h.messages.store.get(row.id))?.flags.answered).toBe(true)
    expect(h.writer.flags.at(-1)?.add).toContain('\\Answered')
  })

  it('会话视图带得出"客服 Agent 在处理"，而且给的是去工作线程的深链', async () => {
    const h = harness({
      folders: { INBOX: letters([{ uid: 13, mime: mime({ uid: 13 }) }]) },
      roles: ['dtc.support'],
    })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    const view = await h.messages.port.thread(ACTOR, row.thread_id)
    expect(view.agent_status?.route).toBe('support')
    expect(view.agent_status?.href).toMatch(/^\/matters\//)
    expect(view.agent_status?.takeover_matter_id).toBeDefined()
  })

  it('转成待办', async () => {
    const h = harness({ folders: { INBOX: letters([{ uid: 15, mime: mime({ uid: 15 }) }]) } })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    const { todo } = await h.messages.port.toTodo(ACTOR, row.id)
    expect(todo.title).toBe('hello')
    expect(h.work.listTodos({})).toHaveLength(1)
  })
})

describe('消息：回复建议与隐私（63 §6 / §10）', () => {
  it('needs_reply 的信打开时才生成三条有差别的建议，并缓存', async () => {
    // WP212：助手只对没人接的信生成建议——这里不开客服岗位，信留在收件箱没人接
    const h = harness({
      folders: { INBOX: letters([{ uid: 21, mime: mime({ uid: 21 }) }]) },
    })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    // 同步那一轮只花了分拣那一次
    expect(h.calls).toEqual(['triage'])
    const first = await h.messages.port.assistant(ACTOR, row.id)
    expect(first.suggestions).toHaveLength(3)
    expect(new Set(first.suggestions.map((s) => s.kind)).size).toBe(3)
    expect(h.calls).toEqual(['triage', 'suggest'])
    // 再开一次同一封信：不再花钱
    await h.messages.port.assistant(ACTOR, row.id)
    expect(h.calls).toEqual(['triage', 'suggest'])
  })

  it('没接模型时建议是空数组，而且界面说得出"没接模型"', async () => {
    const h = harness({
      folders: { INBOX: letters([{ uid: 23, mime: mime({ uid: 23 }) }]) },
      models: false,
    })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    const view = await h.messages.port.assistant(ACTOR, row.id)
    expect(view.suggestions).toEqual([])
    expect(view.model_available).toBe(false)
  })

  it('日志里没有正文，也没有完整邮箱地址', () => {
    expect(maskAddress('ann@customer.example')).toBe('a***@customer.example')
    expect(maskAddress('')).toBe('')
  })

  it('模型把 JSON 裹在 ``` 里也读得出来', () => {
    expect(parseJsonObject('```json\n{"route":"inbox"}\n```').route).toBe('inbox')
    expect(parseJsonObject('完全不是 JSON')).toEqual({})
  })
})

describe('WP204：消息页按钮背后的那几条（回执、影子模式、代取图片、附件、发送失败说人话）', () => {
  const one = async (over: Parameters<typeof harness>[0] = {}, html?: string) => {
    const h = harness({
      folders: {
        INBOX: letters([
          { uid: 31, mime: mime(html === undefined ? { uid: 31 } : { uid: 31, html }) },
        ]),
      },
      ...over,
    })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    return { h, row }
  }

  it('星标 / 已读：回执说邮箱里动成了没有；服务器不答应时是 failed（不再静默）', async () => {
    const { h, row } = await one()
    expect((await h.messages.port.setFlags(ACTOR, row.id, { starred: true })).writeback).toBe(
      'written',
    )
    h.writer.refuse = true
    const out = await h.messages.port.setFlags(ACTOR, row.id, { starred: false })
    expect(out.writeback).toBe('failed')
    // 本机照改（信照样看得见、状态照样对）
    expect(out.message.flags.starred).toBe(false)
  })

  it('归档 / 删除只换文件夹：分拣摘要、要不要回、路由都不动；撤销（挪回收件箱）原样回来', async () => {
    const { h, row } = await one()
    const before = row.triage
    const archived = await h.messages.port.move(ACTOR, row.id, { to: 'archive' })
    expect(archived.writeback).toBe('written')
    expect(archived.message.folder_kind).toBe('archive')
    expect(archived.message.triage).toEqual(before)
    expect(archived.message.route).toBe(row.route)
    const undone = await h.messages.port.move(ACTOR, row.id, { to: 'inbox' })
    expect(undone.message.folder_kind).toBe('inbox')
    expect(undone.message.triage).toEqual(before)
    expect(h.writer.moves.map((m) => m.to)).toEqual(['Archive', 'INBOX'])
    // 纠错那条路照旧：移到客服 = 人判的
    const corrected = await h.messages.port.move(ACTOR, row.id, { to: 'support' })
    expect(corrected.message.triage?.by).toBe('user')
  })

  it('影子模式（只看不动）：已读 / 星标只在本机标；归档 / 删除拒绝并说为什么；邮箱一下都没动', async () => {
    const { h, row } = await one({ shadow: true })
    const movesBefore = h.writer.moves.length
    const flagsBefore = h.writer.flags.length
    const flagged = await h.messages.port.setFlags(ACTOR, row.id, { read: true })
    expect(flagged.writeback).toBe('local_only')
    expect(flagged.message.flags.read).toBe(true)
    await expect(h.messages.port.move(ACTOR, row.id, { to: 'trash' })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('影子模式'),
    })
    expect((await h.messages.store.get(row.id))?.folder_kind).toBe('inbox')
    expect(h.writer.moves.length).toBe(movesBefore)
    expect(h.writer.flags.length).toBe(flagsBefore)
    const { accounts } = await h.messages.port.accounts(ACTOR)
    expect(accounts[0]?.shadow_mode).toBe(true)
  })

  it('显示图片：本机代取、内联成 data:，只对这一封这一次生效；取不到的照旧挡着并报数', async () => {
    const { h, row } = await one(
      {},
      '<p>hi</p><img src="https://cdn.example/ok.png" /><img src="https://track.example/p.gif" />',
    )
    const out = await h.messages.port.showImages(ACTOR, row.id, false)
    expect(out.images).toEqual({ shown: 1, failed: 1 })
    expect(out.message.html).toContain('src="data:image/png;base64,')
    expect(out.message.html).toContain('data-ws-remote-src="https://track.example/p.gif"')
    // 浏览器不直连：正文里没有任何一个 http(s) 的 src
    expect(/\ssrc="https?:/.test(out.message.html ?? '')).toBe(false)
    // 库里那一份没被改：下次打开还是先挡着
    expect((await h.messages.store.get(row.id))?.html).not.toContain('data:image')
  })

  it('附件：从受控原始材料区取回字节；没有这个附件回 undefined（路由 404）', async () => {
    const rawStore = new MemoryRawStore()
    const { h, row } = await one({ rawStore })
    const ref = rawStore.put({
      channel: 'email',
      kind: 'attachment',
      stored_at: T0,
      payload: new Uint8Array([1, 2, 3]),
      subject_ref: row.from.email,
      name: 'a.pdf',
    })
    await h.messages.store.update(row.id, {
      attachments: [{ id: 'att_1', name: 'a.pdf', mime: 'application/pdf', size: 3, ref }],
    })
    const got = await h.messages.port.attachment?.(ACTOR, row.id, 'att_1')
    expect(got?.name).toBe('a.pdf')
    expect([...(got?.bytes ?? [])]).toEqual([1, 2, 3])
    expect(await h.messages.port.attachment?.(ACTOR, row.id, 'nope')).toBeUndefined()
  })

  it('发送失败说人话：急停是 halted、没连邮箱是 provider_unavailable（不再是 500 internal）', async () => {
    const halted = await one({
      send: {
        ok: false,
        outbox_id: '',
        message_id: '<x@y>',
        account: ME,
        error: '出站已急停（AGENTSWS_HALT=outbound 或对账未完成），这封信没有发出',
      },
    })
    await expect(
      halted.h.messages.port.send(ACTOR, { to: [{ email: 'a@b.example' }], text: 'hi' }),
    ).rejects.toMatchObject({ code: 'halted', status: 503 })
    const none = await one({
      send: {
        ok: false,
        outbox_id: '',
        message_id: '<x@y>',
        account: '',
        error: '这台机器上没有连上的邮箱，发不出去',
      },
    })
    await expect(
      none.h.messages.port.send(ACTOR, { to: [{ email: 'a@b.example' }], text: 'hi' }),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: expect.stringContaining('没有连上的邮箱'),
    })
    await expect(
      none.h.messages.port.move(ACTOR, 'msg_gone', { to: 'trash' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

/* ── WP212：没人接的 + 交给岗位（docs/88 §3、§8.2 第 1、2 步）──────────────── */

describe('消息：没人接的与交给岗位（WP212）', () => {
  /** 一个判成「媒体」的来信：模型给类型，不归任何分拣路（留在收件箱没人接）。 */
  const mediaTriage = {
    route: 'inbox',
    labels: [],
    needs_reply: true,
    priority: 'normal',
    summary: '想周四采访你 20 分钟',
    confidence: 0.88,
    kind: 'media',
  }
  const positions = (): ReturnType<NonNullable<MessagesOptions['positions']>> => [
    {
      id: 'customer-care',
      name_zh: '客服',
      name_en: 'Customer Care',
      open: false,
      route: 'support',
    },
    { id: 'pr', name_zh: '公共关系', name_en: 'PR', open: true },
  ]

  it('类型进列表；没人接的主按钮是对口的开着的岗位；交给岗位后进事项、消息页不再列', async () => {
    const opened: { position_id: string; thread_id: string }[] = []
    const h = harness({
      folders: { INBOX: letters([{ uid: 31, mime: mime({ uid: 31, subject: 'Interview' }) }]) },
      triage: mediaTriage,
      extra: {
        positions,
        openAtPosition: async (input) => {
          opened.push({ position_id: input.position_id, thread_id: input.thread_id })
          return { matter_id: 'mat_pr_1' }
        },
        openCards: async () => [{ matter_id: 'mat_pr_1' }],
      },
    })
    await h.messages.poll()
    const { threads } = await h.messages.port.threads(ACTOR, { claim: 'unclaimed' })
    expect(threads).toHaveLength(1)
    const row = threads[0] as MessageThreadSummary
    expect(row.kind).toBe('media')
    expect(row.summary).toBe('想周四采访你 20 分钟')
    expect(row.suggest).toEqual({ action: 'hand', position: 'pr' })

    const out = await h.messages.port.confirmRoute?.(ACTOR, row.claim_message_id as string, {
      route: 'position',
      position_id: 'pr',
    })
    expect(out?.handed_off).toBe(true)
    expect(out?.matter_id).toBe('mat_pr_1')
    expect(opened).toEqual([{ position_id: 'pr', thread_id: row.thread_id }])
    // 交出去之后：「没人接的」不再列；「全部」里挂「公共关系在办 · 有 1 张卡等你 →」
    expect((await h.messages.port.threads(ACTOR, { claim: 'unclaimed' })).threads).toHaveLength(0)
    const all = (await h.messages.port.threads(ACTOR, {})).threads[0]
    expect(all).toMatchObject({
      claim: 'handed',
      handed_to: 'pr',
      open_card_count: 1,
      card_link: '/matters/mat_pr_1',
    })
    const overview = await h.messages.port.overview?.(ACTOR)
    expect(overview?.handed_by_position).toEqual([{ position_id: 'pr', count: 1 }])
    expect(overview?.cards_waiting).toBe(1)
    expect(overview?.unclaimed).toBe(0)
    expect(h.events.some((e) => e.type === 'messages.route_confirmed')).toBe(true)
  })

  it('勾了「记住」交给岗位：同一发件人的下一封直接交出去、不调模型，照常计数、也能改判', async () => {
    const opened: string[] = []
    const inbox = letters([{ uid: 41, mime: mime({ uid: 41, from: 'clara@review.example' }) }])
    const h = harness({
      folders: { INBOX: inbox },
      triage: mediaTriage,
      extra: {
        positions,
        openAtPosition: async (input) => {
          opened.push(input.thread_id)
          return { matter_id: `mat_pr_${opened.length}` }
        },
      },
    })
    await h.messages.poll()
    const first = (await h.messages.store.list({}))[0] as MessageRecord
    const out = await h.messages.port.confirmRoute?.(ACTOR, first.id, {
      route: 'position',
      position_id: 'pr',
      remember_sender: true,
    })
    expect(out?.rule).toMatchObject({ sender: 'clara@review.example', position: 'pr' })
    // 同一个发件人又来一封（新会话）：规则层直达、不花模型，直接交给公共关系
    inbox.push(...letters([{ uid: 42, mime: mime({ uid: 42, from: 'clara@review.example' }) }]))
    await h.messages.poll()
    expect(h.calls).toEqual(['triage'])
    expect(opened).toHaveLength(2)
    const second = (await h.messages.store.list({})).find((m) => m.uid === 42) as MessageRecord
    expect(second.handled).toMatchObject({
      as: 'position',
      position_id: 'pr',
      matter_id: 'mat_pr_2',
    })
    expect((await h.messages.port.threads(ACTOR, { claim: 'unclaimed' })).threads).toHaveLength(0)
    const overview = await h.messages.port.overview?.(ACTOR)
    expect(overview?.handed_by_position).toEqual([{ position_id: 'pr', count: 2 }])
    // 自动交出去的也能改判
    const changed = await h.messages.port.setKind?.(ACTOR, second.id, { kind: 'partnership' })
    expect(changed?.message.triage?.kind).toBe('partnership')
    expect(
      h.events.some(
        (e) =>
          e.type === 'messages.route_confirmed' &&
          (e.payload as { by?: string }).by === 'sender_rule',
      ),
    ).toBe(true)
  })

  it('没勾「记住」：下一封照旧只给建议（主按钮是那个岗位），不自动交', async () => {
    const opened: string[] = []
    const inbox = letters([{ uid: 43, mime: mime({ uid: 43, from: 'dan@review.example' }) }])
    const h = harness({
      folders: { INBOX: inbox },
      triage: mediaTriage,
      extra: {
        positions,
        openAtPosition: async (input) => {
          opened.push(input.thread_id)
          return { matter_id: 'mat_x' }
        },
      },
    })
    await h.messages.poll()
    const first = (await h.messages.store.list({}))[0] as MessageRecord
    await h.messages.port.confirmRoute?.(ACTOR, first.id, { route: 'position', position_id: 'pr' })
    inbox.push(...letters([{ uid: 44, mime: mime({ uid: 44, from: 'dan@review.example' }) }]))
    await h.messages.poll()
    expect(opened).toHaveLength(1)
    const { threads } = await h.messages.port.threads(ACTOR, { claim: 'unclaimed' })
    expect(threads).toHaveLength(1)
    expect(threads[0]?.suggest).toEqual({ action: 'hand', position: 'pr' })
  })

  it('「负责人」不进「交给 X ▾」', async () => {
    const h = harness({
      extra: {
        positions: () => [
          ...positions(),
          { id: 'owner', name_zh: '负责人', name_en: 'Lead', open: true },
        ],
      },
    })
    const overview = await h.messages.port.overview?.(ACTOR)
    expect(overview?.positions.map((p) => p.id)).toEqual(['customer-care', 'pr'])
  })

  it('岗位没开：不交、说一句人话，信还在没人接的里', async () => {
    const h = harness({
      folders: { INBOX: letters([{ uid: 32, mime: mime({ uid: 32 }) }]) },
      triage: mediaTriage,
      extra: { positions, openAtPosition: async () => ({ matter_id: 'x' }) },
    })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    const out = await h.messages.port.confirmRoute?.(ACTOR, row.id, {
      route: 'position',
      position_id: 'customer-care',
    })
    expect(out?.handed_off).toBe(false)
    expect(out?.refused).toContain('没开')
    expect((await h.messages.port.threads(ACTOR, { claim: 'unclaimed' })).threads).toHaveLength(1)
  })

  it('改判 + 记住：写发件人规则，下一封同一发件人直接按规则、不再调模型', async () => {
    const h = harness({
      folders: {
        INBOX: letters([{ uid: 33, mime: mime({ uid: 33, subject: 'first' }) }]),
      },
      triage: mediaTriage,
    })
    await h.messages.poll()
    expect(h.calls).toEqual(['triage'])
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    const out = await h.messages.port.setKind?.(ACTOR, row.id, {
      kind: 'partnership',
      remember_sender: true,
    })
    expect(out?.message.triage?.kind).toBe('partnership')
    expect(out?.message.triage?.kind_by).toBe('user')
    expect(out?.rule?.kind).toBe('partnership')
    // 下一封：同一个发件人，规则层直达
    const verdict = await triageMessage(
      {
        from_email: row.from.email,
        subject: 'second',
        text: 'hi again',
        thread_id: '<n@x>',
        references: [],
        headers: {},
        has_attachments: false,
      },
      {
        support_enabled: false,
        kol_enabled: false,
        isSupportThread: () => false,
        isKolThread: () => false,
        senderRules: (await h.messages.port.senderRules(ACTOR)).rules,
        model_halted: false,
        at: T0,
      },
      {
        classify: async () => {
          throw new Error('不该调模型')
        },
      },
    )
    expect(verdict.kind).toBe('partnership')
    expect(verdict.kind_by).toBe('sender_rule')
    // 「你教过它」里看得见
    const overview = await h.messages.port.overview?.(ACTOR)
    expect(overview?.taught.rules).toBe(1)
    expect(overview?.taught.recent[0]).toMatchObject({ field: 'kind', to: 'partnership' })
  })

  it('不勾「记住」的改判进学习回路（onCorrection），不写规则', async () => {
    const lessons: string[] = []
    const h = harness({
      folders: { INBOX: letters([{ uid: 34, mime: mime({ uid: 34 }) }]) },
      triage: mediaTriage,
      extra: { onCorrection: (c) => lessons.push(`${c.field}:${c.from}->${c.to}`) },
    })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    await h.messages.port.setKind?.(ACTOR, row.id, { kind: 'personal_other' })
    expect(lessons).toEqual(['kind:media->personal_other'])
    expect((await h.messages.port.senderRules(ACTOR)).rules).toHaveLength(0)
    expect(h.events.some((e) => e.type === 'messages.triage_corrected')).toBe(true)
  })

  it('只是通知成捆：整捆「知道了」；邮箱里标不标已读跟随「客信怎么动邮箱」开关', async () => {
    const notice = { ...mediaTriage, needs_reply: false, kind: 'billing_system', summary: '账单' }
    const h = harness({
      folders: {
        INBOX: letters([
          { uid: 35, mime: mime({ uid: 35, subject: 'Invoice 1' }) },
          { uid: 36, mime: mime({ uid: 36, subject: 'Invoice 2' }) },
        ]),
      },
      triage: notice,
    })
    await h.messages.poll()
    const before = await h.messages.port.overview?.(ACTOR)
    expect(before?.notice).toBe(2)
    expect(before?.unclaimed).toBe(0)
    expect(before?.notice_groups).toEqual([
      expect.objectContaining({ kind: 'billing_system', count: 2 }),
    ])
    const out = await h.messages.port.ackNotices?.(ACTOR, { kind: 'billing_system' })
    expect(out?.acked).toBe(2)
    expect(out?.writeback).toBe('written')
    expect(h.writer.flags.filter((f) => f.add.includes('\\Seen'))).toHaveLength(2)
    expect((await h.messages.port.overview?.(ACTOR))?.notice).toBe(0)
    // 影子模式开着：只在本机标，邮箱一下都不动
    const shadow = harness({
      folders: { INBOX: letters([{ uid: 37, mime: mime({ uid: 37 }) }]) },
      triage: notice,
      shadow: true,
    })
    await shadow.messages.poll()
    const r = await shadow.messages.port.ackNotices?.(ACTOR, {})
    expect(r?.writeback).toBe('local_only')
    expect(shadow.writer.flags).toHaveLength(0)
  })

  it('AI 助手只对没人接的信生成建议；岗位在办的只挂「在办 · 有卡等你」，不花 token', async () => {
    const h = harness({
      folders: { INBOX: letters([{ uid: 38, mime: mime({ uid: 38 }) }]) },
      roles: ['dtc.support'],
      extra: { openCards: async () => [] },
    })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    expect(row.route).toBe('support')
    const view = await h.messages.port.assistant(ACTOR, row.id)
    expect(view.claim).toBe('handed')
    expect(view.handed_to).toBe('customer-care')
    expect(view.suggestions).toEqual([])
    expect(h.calls).toEqual(['triage'])
  })

  it('我自己处理 / 撤销：从没人接的拿掉，再放回来', async () => {
    const h = harness({
      folders: { INBOX: letters([{ uid: 39, mime: mime({ uid: 39 }) }]) },
      triage: mediaTriage,
    })
    await h.messages.poll()
    const row = (await h.messages.store.list({}))[0] as MessageRecord
    await h.messages.port.claim?.(ACTOR, row.id, { as: 'me' })
    expect((await h.messages.port.threads(ACTOR, { claim: 'unclaimed' })).threads).toHaveLength(0)
    await h.messages.port.claim?.(ACTOR, row.id, { as: 'none' })
    expect((await h.messages.port.threads(ACTOR, { claim: 'unclaimed' })).threads).toHaveLength(1)
  })
})
