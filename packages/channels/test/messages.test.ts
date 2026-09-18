/**
 * WP113（63）：消息那一层的用例。
 *
 * 分四组，每组钉住的都是一条"错了就很难发现"的纪律：
 * ① 净化：远程图片默认不发请求、脚本与事件属性一个不留；
 * ② 分拣：前三层不花模型、岗位没开不挪信、把握不够不挪信、急停只跑规则；
 * ③ 库：两个实现（内存 / SQLite）**同一份用例跑两遍**，搜索与会话聚合必须一致；
 * ④ 同步：多文件夹各一个游标、挪信失败只 log、同一封信换文件夹不重分拣。
 */
import type { Clock, MessageRecord, MessageTriage, SenderRule } from '@agentsws/contracts'
import { TRIAGE_CONFIDENCE_FLOOR } from '@agentsws/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import type { MailSource, RawEmailMessage } from '../src/email/imap.js'
import {
  aggregateThreads,
  BUILTIN_LABELS,
  folderKindOf,
  folderPathFor,
  isAutomatedMail,
  MailboxSync,
  MemoryMailboxStateStore,
  MemoryMessageStore,
  type MessageStore,
  matchSenderRule,
  parseMessage,
  ReplySuggester,
  restoreRemoteImages,
  SqliteMessageStore,
  sanitizeMessageHtml,
  type TriageContext,
  type TriageInput,
  triageByRules,
  triageMessage,
} from '../src/index.js'
import type { MailboxWriter } from '../src/messages/writeback.js'

const T0 = '2026-09-18T02:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }
const WS = 'ws_1'
const ME = 'hello@shop.example'

/* ── ① 净化 ───────────────────────────────────────────────────────────── */

describe('HTML 净化（63 §7）', () => {
  it('脚本、样式、事件属性与 javascript: 链接一个都不留', () => {
    const { html } = sanitizeMessageHtml(
      `<div onclick="steal()"><script>fetch('//evil')</script><style>b{}</style>` +
        `<a href="javascript:alert(1)">点我</a><a href="https://ok.example">好的</a></div>`,
    )
    expect(html).not.toContain('script')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="https://ok.example"')
    // 外链一律新窗口 + 断 opener
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('远程图片搬到 data-* 上——在人按"显示图片"之前一个请求都不发', () => {
    const out = sanitizeMessageHtml('<p>hi</p><img src="https://track.example/p.gif?u=1" />')
    expect(out.has_remote_images).toBe(true)
    // 注意判的是**属性边界**：`data-ws-remote-src=` 里也含 `src=` 那几个字
    expect(/(?:^|\s)src="https:/.test(out.html)).toBe(false)
    expect(out.html).toContain('data-ws-remote-src="https://track.example/p.gif?u=1"')
    // 按下"显示图片"之后才搬回去
    expect(restoreRemoteImages(out.html)).toContain('src="https://track.example/p.gif?u=1"')
  })

  it('cid: 内嵌图不算远程（它就在这封信里）', () => {
    const out = sanitizeMessageHtml('<img src="cid:logo@x" />')
    expect(out.has_remote_images).toBe(false)
    expect(out.html).toContain('src="cid:logo@x"')
  })

  it('iframe 整段扔掉，不留它的内容', () => {
    const { html } = sanitizeMessageHtml('<p>a</p><iframe src="https://x"><b>藏在里面</b></iframe>')
    expect(html).toContain('<p>a</p>')
    expect(html).not.toContain('藏在里面')
  })
})

/* ── ② 分拣 ───────────────────────────────────────────────────────────── */

const input = (over: Partial<TriageInput> = {}): TriageInput => ({
  from_email: 'ann@customer.example',
  subject: '我的包裹破了',
  text: 'The box arrived damaged, I want a refund.',
  thread_id: '<t1@x>',
  references: [],
  headers: {},
  has_attachments: false,
  ...over,
})

const ctx = (over: Partial<TriageContext> = {}): TriageContext => ({
  support_enabled: true,
  kol_enabled: true,
  isSupportThread: () => false,
  isKolThread: () => false,
  senderRules: [],
  model_halted: false,
  at: T0,
  ...over,
})

const alwaysSupport = {
  calls: 0,
  async classify(): Promise<{
    route: 'support'
    labels: string[]
    needs_reply: boolean
    priority: 'normal'
    summary: string
    confidence: number
  }> {
    this.calls += 1
    return {
      route: 'support',
      labels: ['orders'],
      needs_reply: true,
      priority: 'normal',
      summary: '客户说包裹破损要退款',
      confidence: 0.9,
    }
  },
}

describe('分拣（63 §4）', () => {
  beforeEach(() => {
    alwaysSupport.calls = 0
  })

  it('① 线程命中客服已有线程 → 直接归客服，不花模型', async () => {
    const out = await triageMessage(
      input(),
      ctx({ isSupportThread: () => true }),
      alwaysSupport as never,
    )
    expect(out.route).toBe('support')
    expect(out.by).toBe('rule')
    expect(alwaysSupport.calls).toBe(0)
  })

  it('② 用户教过的发件人规则直达，不花模型', async () => {
    const rule: SenderRule = {
      id: 'r1',
      sender: '@customer.example',
      route: 'support',
      labels: ['orders'],
      by: 'p1',
      created_at: T0,
    }
    const out = await triageMessage(input(), ctx({ senderRules: [rule] }), alwaysSupport as never)
    expect(out.route).toBe('support')
    expect(out.by).toBe('rule')
    expect(out.reasons.join()).toContain('@customer.example')
    expect(alwaysSupport.calls).toBe(0)
  })

  it('整地址的规则比整域的更具体，赢', () => {
    const rules: SenderRule[] = [
      { id: 'd', sender: '@x.com', labels: [], by: 'p', created_at: T0 },
      { id: 'a', sender: 'ann@x.com', labels: [], by: 'p', created_at: T0 },
    ]
    expect(matchSenderRule(rules, 'Ann@X.com')?.id).toBe('a')
    expect(matchSenderRule(rules, 'bob@x.com')?.id).toBe('d')
  })

  it('③ 有 List-Unsubscribe 的群发走规则，不花模型', async () => {
    const mail = input({
      subject: '本周新品 30% off',
      text: 'shop now',
      headers: { 'list-unsubscribe': '<https://x/u>' },
    })
    expect(isAutomatedMail(mail)).toBe('List-Unsubscribe')
    const out = await triageMessage(mail, ctx(), alwaysSupport as never)
    expect(out.route).toBe('inbox')
    expect(out.labels).toContain('newsletters')
    expect(out.needs_reply).toBe(false)
    expect(alwaysSupport.calls).toBe(0)
  })

  it('订单通知走规则时不再顶着"营销订阅"那一格', async () => {
    const out = await triageMessage(
      input({
        subject: 'Your order has shipped',
        text: 'tracking 123',
        headers: { precedence: 'bulk' },
      }),
      ctx(),
    )
    expect(out.labels).toContain('orders')
    expect(out.labels).not.toContain('newsletters')
  })

  it('④ 规则分不出来才走模型', async () => {
    const out = await triageMessage(input(), ctx(), alwaysSupport as never)
    expect(alwaysSupport.calls).toBe(1)
    expect(out.route).toBe('support')
    expect(out.by).toBe('model')
  })

  it('没开客服岗位：模型判成 support 也降回收件箱，只打标签', async () => {
    const out = await triageMessage(
      input(),
      ctx({ support_enabled: false }),
      alwaysSupport as never,
    )
    expect(out.route).toBe('inbox')
    expect(out.reasons.join()).toContain('没启用')
  })

  it('没开红人岗位：红人回信留 INBOX，标签仍是合作邀约', async () => {
    const shy = {
      classify: async () => ({
        route: 'kol' as const,
        labels: ['partnership'],
        needs_reply: true,
        priority: 'normal' as const,
        summary: '红人想谈合作',
        confidence: 0.95,
      }),
    }
    const out = await triageMessage(
      input({ subject: 'collab?', text: 'I would love a brand deal' }),
      ctx({ kol_enabled: false }),
      shy,
    )
    expect(out.route).toBe('inbox')
    expect(out.labels).toContain('partnership')
  })

  it(`把握 < ${TRIAGE_CONFIDENCE_FLOOR} 的 support 判定不挪信，只挂"像是客服信？"`, async () => {
    const shy = {
      classify: async () => ({
        route: 'support' as const,
        labels: [],
        needs_reply: true,
        priority: 'normal' as const,
        summary: '也许是客服信',
        confidence: 0.4,
      }),
    }
    const out = await triageMessage(input(), ctx(), shy)
    expect(out.route).toBe('inbox')
    expect(out.suggested_route).toBe('support')
  })

  it('halt.model 开着：只跑规则，剩下的标「未分拣」', async () => {
    const out = await triageMessage(input(), ctx({ model_halted: true }), alwaysSupport as never)
    expect(out.by).toBe('halted')
    expect(out.route).toBe('inbox')
    expect(alwaysSupport.calls).toBe(0)
  })

  it('模型抛异常不让这封信进不来——落兜底，界面显示未分拣', async () => {
    const broken = {
      classify: async () => {
        throw new Error('gateway down')
      },
    }
    const out = await triageMessage(input(), ctx(), broken)
    expect(out.route).toBe('inbox')
    expect(out.by).toBe('rule')
  })

  it('规则层分不出来时回 undefined（调用方据此才去花模型）', () => {
    expect(triageByRules(input(), ctx())).toBeUndefined()
  })

  it('摘要裁到 40 字', async () => {
    const wordy = {
      classify: async () => ({
        route: 'inbox' as const,
        labels: [],
        needs_reply: false,
        priority: 'low' as const,
        summary: '啊'.repeat(200),
        confidence: 0.9,
      }),
    }
    const out = await triageMessage(input(), ctx(), wordy)
    expect(out.summary.length).toBeLessThanOrEqual(40)
  })
})

/* ── ③ 消息库（两个实现同一份用例） ───────────────────────────────────── */

const record = (over: Partial<MessageRecord> = {}): MessageRecord => ({
  id: 'm1',
  workspace_id: WS,
  source: 'email',
  account: ME,
  folder: 'INBOX',
  folder_kind: 'inbox',
  thread_id: '<t1@x>',
  message_id: '<m1@x>',
  references: [],
  from: { email: 'ann@customer.example', name: 'Ann' },
  to: [{ email: ME }],
  cc: [],
  bcc: [],
  subject: '包裹破了',
  snippet: 'The box arrived damaged',
  text: 'The box arrived damaged, I want a refund.',
  has_remote_images: false,
  attachments: [],
  date: '2026-09-18T01:00:00.000Z',
  received_at: T0,
  flags: { read: false, starred: false, answered: false, draft: false },
  labels: [],
  route: 'inbox',
  ...over,
})

function storeSuite(name: string, make: () => MessageStore): void {
  describe(`消息库 · ${name}`, () => {
    it('落库、按 Message-ID 去重、局部改', async () => {
      const store = make()
      await store.put(record())
      expect((await store.find(ME, '<m1@x>'))?.id).toBe('m1')
      await store.update('m1', {
        flags: { read: true, starred: true, answered: false, draft: false },
      })
      expect((await store.get('m1'))?.flags.read).toBe(true)
    })

    it('搜索命中发件人 / 主题 / 正文 / 标签四处', async () => {
      const store = make()
      await store.put(record({ labels: ['orders'] }))
      for (const q of ['ann@customer', '包裹', 'damaged', 'orders']) {
        expect((await store.list({ q })).length, q).toBe(1)
      }
      expect((await store.list({ q: '不存在的词' })).length).toBe(0)
    })

    it('会话聚合：未读数是"这条会话里还有几封没读"，文件夹是并集', async () => {
      const store = make()
      await store.put(record({ id: 'a', message_id: '<a@x>' }))
      await store.put(
        record({
          id: 'b',
          message_id: '<b@x>',
          folder: 'kefuagents',
          folder_kind: 'support',
          date: '2026-09-18T01:30:00.000Z',
          flags: { read: true, starred: true, answered: false, draft: false },
        }),
      )
      const threads = await store.threads({})
      expect(threads).toHaveLength(1)
      const t = threads[0]
      expect(t?.count).toBe(2)
      expect(t?.unread).toBe(1)
      expect(t?.starred).toBe(true)
      expect(t?.folders.sort()).toEqual(['INBOX', 'kefuagents'])
      expect(t?.last_message_id).toBe('b')
    })

    it('按文件夹筛也拿得到整条会话（信散在两个文件夹里）', async () => {
      const store = make()
      await store.put(record({ id: 'a', message_id: '<a@x>' }))
      await store.put(
        record({ id: 'b', message_id: '<b@x>', folder: 'kefuagents', folder_kind: 'support' }),
      )
      const threads = await store.threads({ folder: 'INBOX' })
      expect(threads[0]?.count).toBe(2)
    })

    it('文件夹清单带未读数；账号清单是库里见过的那几只', async () => {
      const store = make()
      await store.put(record())
      await store.put(record({ id: 'c', message_id: '<c@x>', account: 'kol@shop.example' }))
      expect((await store.accounts()).length).toBe(2)
      const folders = await store.folders(ME)
      expect(folders).toHaveLength(1)
      expect(folders[0]?.unread).toBe(1)
    })

    it('内置标签删不掉；自建标签删掉会从所有信上摘干净', async () => {
      const store = make()
      expect((await store.labels()).length).toBeGreaterThanOrEqual(BUILTIN_LABELS.length)
      expect(await store.deleteLabel('orders')).toBe(false)
      await store.putLabel({
        id: 'mine',
        name_zh: '我的',
        name_en: 'Mine',
        color: 'blue',
        builtin: false,
      })
      await store.put(record({ labels: ['mine'] }))
      expect(await store.deleteLabel('mine')).toBe(true)
      expect((await store.get('m1'))?.labels).toEqual([])
    })

    it('草稿、发件人规则、信任名单各自存得下', async () => {
      const store = make()
      await store.putDraft({
        id: 'd1',
        workspace_id: WS,
        account: ME,
        to: [{ email: 'ann@customer.example' }],
        cc: [],
        bcc: [],
        subject: 'Re: 包裹破了',
        text: '这就给你补发',
        attachments: [],
        updated_at: T0,
      })
      expect((await store.drafts()).length).toBe(1)
      expect(await store.deleteDraft('d1')).toBe(true)
      await store.putSenderRule({
        id: 'r1',
        sender: 'ann@customer.example',
        route: 'support',
        labels: [],
        by: 'p1',
        created_at: T0,
      })
      expect((await store.senderRules()).length).toBe(1)
      await store.trustSender('ANN@customer.example')
      expect(await store.trustedSenders()).toEqual(['ann@customer.example'])
    })
  })
}

storeSuite('内存', () => new MemoryMessageStore())
storeSuite('SQLite', () => new SqliteMessageStore({ clock }))

describe('文件夹语义', () => {
  it('各家真名映射到同一个语义', () => {
    expect(folderKindOf('INBOX')).toBe('inbox')
    expect(folderKindOf('[Gmail]/Sent Mail')).toBe('sent')
    expect(folderKindOf('已发送')).toBe('sent')
    expect(folderKindOf('kefuagents')).toBe('support')
    expect(folderKindOf('kolagents')).toBe('kol')
    expect(folderKindOf('Project X')).toBe('custom')
  })

  it('挪信时按这只邮箱上的真名走；没有就用缺省名', () => {
    expect(folderPathFor('sent', ['INBOX', '[Gmail]/Sent Mail'])).toBe('[Gmail]/Sent Mail')
    expect(folderPathFor('trash', ['INBOX'])).toBe('Trash')
  })
})

describe('会话聚合（纯函数）', () => {
  it('空进空出，不抛', () => {
    expect(aggregateThreads([])).toEqual([])
  })
})

/* ── ④ 同步 ───────────────────────────────────────────────────────────── */

const mime = (
  n: number,
  over: { from?: string; subject?: string; extra?: string[] } = {},
): string =>
  [
    `From: ${over.from ?? 'ann@customer.example'}`,
    `To: ${ME}`,
    `Subject: ${over.subject ?? `letter ${n}`}`,
    `Message-ID: <m-${n}@mail.example>`,
    'Date: Fri, 18 Sep 2026 01:00:00 +0000',
    ...(over.extra ?? []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `body ${n}`,
    '',
  ].join('\r\n')

class FolderSource implements MailSource {
  constructor(
    readonly folder: string,
    readonly messages: RawEmailMessage[],
  ) {}
  async fetchSince(since: number): Promise<RawEmailMessage[]> {
    return this.messages.filter((m) => m.uid > since)
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async uidValidity(): Promise<number> {
    return 1
  }
}

class FakeWriter implements MailboxWriter {
  readonly moves: { folder: string; uid: number; to: string }[] = []
  readonly flags: { folder: string; uid: number; add: string[]; remove: string[] }[] = []
  ok = true
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
    if (!this.ok) return false
    this.moves.push({ folder, uid, to })
    return true
  }
}

function makeSync(
  store: MessageStore,
  opts: {
    folders: Record<string, RawEmailMessage[]>
    triage: (r: MessageRecord) => Promise<MessageTriage>
    handoff?: (r: MessageRecord, t: MessageTriage) => Promise<boolean>
    writer?: MailboxWriter
    errors?: unknown[]
  },
): MailboxSync {
  return new MailboxSync({
    clock,
    workspace_id: WS,
    store,
    state: new MemoryMailboxStateStore(),
    accounts: () => [
      {
        address: ME,
        folders: Object.keys(opts.folders),
        open: (folder) => new FolderSource(folder, opts.folders[folder] ?? []),
        ...(opts.writer === undefined ? {} : { writer: opts.writer }),
      },
    ],
    triage: opts.triage,
    ...(opts.handoff === undefined ? {} : { handoff: opts.handoff }),
    on_error: (e) => opts.errors?.push(e),
  })
}

const inboxTriage = async (): Promise<MessageTriage> => ({
  route: 'inbox',
  labels: ['orders'],
  needs_reply: false,
  priority: 'low',
  summary: '订单通知',
  confidence: 0.9,
  by: 'rule',
  reasons: [],
  at: T0,
})

const supportTriage = async (): Promise<MessageTriage> => ({
  route: 'support',
  labels: [],
  needs_reply: true,
  priority: 'high',
  summary: '客服信',
  confidence: 0.95,
  by: 'model',
  reasons: [],
  at: T0,
})

describe('全量同步（63 §3）', () => {
  it('六个文件夹各扫各的，已发 / 草稿 / 垃圾箱里的信不分拣', async () => {
    const store = new MemoryMessageStore()
    let triaged = 0
    const sync = makeSync(store, {
      folders: {
        INBOX: [{ uid: 1, mailbox: 'INBOX', source: mime(1) }],
        Sent: [{ uid: 1, mailbox: 'Sent', source: mime(2) }],
        Drafts: [{ uid: 1, mailbox: 'Drafts', source: mime(3) }],
        Trash: [{ uid: 1, mailbox: 'Trash', source: mime(4) }],
      },
      triage: async () => {
        triaged += 1
        return inboxTriage()
      },
    })
    const report = await sync.sync()
    expect(report.folders).toBe(4)
    expect(report.fetched).toBe(4)
    // 只有 INBOX 那一封过了分拣
    expect(triaged).toBe(1)
    expect((await store.list({})).length).toBe(4)
    expect((await store.list({ folder_kind: 'sent' })).length).toBe(1)
  })

  it('判成客服且那边接了 → MOVE 进 kefuagents，库里也跟着改文件夹', async () => {
    const store = new MemoryMessageStore()
    const writer = new FakeWriter()
    const sync = makeSync(store, {
      folders: { INBOX: [{ uid: 7, mailbox: 'INBOX', source: mime(7) }] },
      triage: supportTriage,
      handoff: async () => true,
      writer,
    })
    const report = await sync.sync()
    expect(report.moved).toBe(1)
    expect(writer.moves).toEqual([{ folder: 'INBOX', uid: 7, to: 'kefuagents' }])
    expect((await store.list({}))[0]?.folder).toBe('kefuagents')
  })

  it('那一侧不接（岗位没开 / 线程建不了）→ 不挪信', async () => {
    const store = new MemoryMessageStore()
    const writer = new FakeWriter()
    const sync = makeSync(store, {
      folders: { INBOX: [{ uid: 7, mailbox: 'INBOX', source: mime(7) }] },
      triage: supportTriage,
      handoff: async () => false,
      writer,
    })
    await sync.sync()
    expect(writer.moves).toEqual([])
    expect((await store.list({}))[0]?.folder).toBe('INBOX')
  })

  it('MOVE 失败只 log，信仍在消息里可见（WP55 的纪律）', async () => {
    const store = new MemoryMessageStore()
    const writer = new FakeWriter()
    writer.ok = false
    const errors: unknown[] = []
    const sync = makeSync(store, {
      folders: { INBOX: [{ uid: 7, mailbox: 'INBOX', source: mime(7) }] },
      triage: supportTriage,
      handoff: async () => true,
      writer,
      errors,
    })
    const report = await sync.sync()
    expect(report.moved).toBe(0)
    expect(errors).toHaveLength(1)
    expect((await store.list({}))[0]?.folder).toBe('INBOX')
  })

  it('第二轮不重拉（每文件夹一个 UID 游标）', async () => {
    const store = new MemoryMessageStore()
    const sync = makeSync(store, {
      folders: { INBOX: [{ uid: 1, mailbox: 'INBOX', source: mime(1) }] },
      triage: inboxTriage,
    })
    expect((await sync.sync()).fetched).toBe(1)
    expect((await sync.sync()).fetched).toBe(0)
  })

  it('同一封信换了文件夹（人在手机上挪过）只更新位置，不重新分拣', async () => {
    const store = new MemoryMessageStore()
    let calls = 0
    const letter = mime(9)
    const sync = makeSync(store, {
      folders: {
        INBOX: [{ uid: 1, mailbox: 'INBOX', source: letter }],
        Archive: [{ uid: 1, mailbox: 'Archive', source: letter }],
      },
      triage: async () => {
        calls += 1
        return inboxTriage()
      },
    })
    await sync.sync()
    expect(calls).toBe(1)
    const rows = await store.list({})
    expect(rows).toHaveLength(1)
    expect(rows[0]?.folder).toBe('Archive')
  })

  it('「再往前取」把回溯下界往前挪', () => {
    const sync = makeSync(new MemoryMessageStore(), { folders: {}, triage: inboxTriage })
    const before = Date.parse(sync.backfillFloor(ME))
    const after = Date.parse(sync.backfill(ME, 30))
    expect(after).toBeLessThan(before)
  })
})

describe('MIME → 消息库那一行', () => {
  it('flags 认得出已读 / 星标；草稿箱里的一律算草稿', async () => {
    const row = await parseMessage({
      raw: {
        uid: 3,
        mailbox: 'Drafts',
        source: mime(3),
        flags: ['\\Seen', '\\Flagged'],
      },
      account: ME,
      folder: 'Drafts',
      workspace_id: WS,
      received_at: T0,
    })
    expect(row.flags).toEqual({ read: true, starred: true, answered: false, draft: true })
    expect(row.folder_kind).toBe('drafts')
    expect(row.from.email).toBe('ann@customer.example')
  })

  it('分拣要看的那几个头从**原始行**里取（mailparser 会把 List-Unsubscribe 藏进 `list`）', async () => {
    const row = await parseMessage({
      raw: {
        uid: 1,
        mailbox: 'INBOX',
        source: mime(1, { extra: ['List-Unsubscribe: <https://brand.example/u>'] }),
      },
      account: ME,
      folder: 'INBOX',
      workspace_id: WS,
      received_at: T0,
    })
    // 这一条错了的后果不是报错，是**每一封群发都白花一次模型**
    expect(row.headers['list-unsubscribe']).toBe('<https://brand.example/u>')
    // 白名单之外的头一个都不留（Received 链与 DKIM 属于原文）
    expect(Object.keys(row.headers)).not.toContain('received')
  })

  it('同一封信在两个文件夹里是同一个 id（按 Message-ID 算身份）', async () => {
    const a = await parseMessage({
      raw: { uid: 1, mailbox: 'INBOX', source: mime(5) },
      account: ME,
      folder: 'INBOX',
      workspace_id: WS,
      received_at: T0,
    })
    const b = await parseMessage({
      raw: { uid: 99, mailbox: 'kefuagents', source: mime(5) },
      account: ME,
      folder: 'kefuagents',
      workspace_id: WS,
      received_at: T0,
    })
    expect(a.id).toBe(b.id)
  })
})

describe('回复建议（63 §6）', () => {
  it('没装模型就回空数组——写信框照常能用', async () => {
    const s = new ReplySuggester({ now: () => 0 })
    expect(
      await s.suggest('m1', {
        subject: 's',
        from: 'a@b.c',
        body: 'x',
        context: [],
        knowledge: [],
        kinds: ['short'],
        lang: 'zh',
      }),
    ).toEqual([])
  })

  it('同一封信只生成一次（打开那封信时才生成并缓存）', async () => {
    let calls = 0
    const s = new ReplySuggester({
      now: () => 0,
      model: {
        suggest: async () => {
          calls += 1
          return [
            { kind: 'short' as const, text: '收到，马上补发。' },
            { kind: 'decline' as const, text: '这次恐怕帮不上。' },
          ]
        },
      },
    })
    const req = {
      subject: 's',
      from: 'a@b.c',
      body: 'x',
      context: [],
      knowledge: [{ source_id: 'k1', title: '退换货政策', text: '30 天无理由' }],
      kinds: ['short', 'decline'] as const,
      lang: 'zh' as const,
    }
    const first = await s.suggest('m1', req)
    await s.suggest('m1', req)
    expect(calls).toBe(1)
    expect(first).toHaveLength(2)
    expect(first[0]?.citations[0]?.title).toBe('退换货政策')
    s.invalidate('m1')
    await s.suggest('m1', req)
    expect(calls).toBe(2)
  })
})
