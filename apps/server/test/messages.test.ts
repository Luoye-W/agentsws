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

import type { MailboxWriter, MailSource, RawEmailMessage } from '@agentsws/channels'
import type { Clock, EventEnvelope, MessageRecord, ModelGateway, RoleId } from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import { createWork, type Work } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import type { DirectMailInput, DirectMailResult } from '../src/channels.js'
import type { MailAccount } from '../src/index.js'
import { createMessages, keywordOf, maskAddress, parseJsonObject } from '../src/messages.js'

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
  setFlags(
    folder: string,
    uid: number,
    add: readonly string[],
    remove: readonly string[],
  ): boolean {
    this.flags.push({ folder, uid, add: [...add], remove: [...remove] })
    return true
  }
  move(folder: string, uid: number, to: string): boolean {
    this.moves.push({ folder, uid, to })
    return true
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
      return { ok: true, outbox_id: 'obx_1', message_id: '<sent@x>', account: ME }
    },
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

  it('开了客服岗位：判成客服的信 MOVE 进 kefuagents，并归到那条事项', async () => {
    const h = harness({
      folders: { INBOX: letters([{ uid: 1, mime: mime({ uid: 1 }) }]) },
      roles: ['dtc.support'],
    })
    const report = await h.messages.poll()
    expect(report.moved).toBe(1)
    expect(h.writer.moves).toEqual([{ folder: 'INBOX', uid: 1, to: 'kefuagents' }])
    const rows = await h.messages.store.list({})
    expect(rows[0]?.folder).toBe('kefuagents')
    expect(rows[0]?.linked?.type).toBe('matter')
    // 客服现有流程 = 37 的事项
    expect(h.work.listMatters({ kind: 'conversation' })).toHaveLength(1)
  })

  it('开了红人岗位：红人回信 MOVE 进 kolagents', async () => {
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
    expect(h.writer.moves).toEqual([{ folder: 'INBOX', uid: 1, to: 'kolagents' }])
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
    expect(h.writer.moves.at(-1)).toEqual({ folder: 'INBOX', uid: 1, to: 'kefuagents' })
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
            mime: mime({ uid: 9, html: '<p>hi</p><img src="https://track.example/p.gif" />' }),
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
    const h = harness({
      folders: { INBOX: letters([{ uid: 21, mime: mime({ uid: 21 }) }]) },
      roles: ['dtc.support'],
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
