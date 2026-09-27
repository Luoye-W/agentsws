/**
 * WP167：收信只走一个入口——消息同步分拣后，只有判成客服的信才交给客服那一路。
 *
 * 这里钉住 channels 包里那几样纯东西：去哪一路（`intakeOf`）、同一封信只进一次的钥匙
 * 与台账（内存 / SQLite 两档）、「待确认」那一栏的筛子，以及消息同步把原始 MIME 与
 * 邮箱地址递给宿主（客服那一路要原信，开关按邮箱各一份）。
 */
import type { Clock, MessageRecord, MessageTriage } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { MailSource, RawEmailMessage } from '../src/email/imap.js'
import {
  aggregateThreads,
  createSqliteChannelStores,
  intakeOf,
  isAutomatedMail,
  MailboxSync,
  MemoryMailboxStateStore,
  MemoryMessageStore,
  MemorySupportIntakeLedger,
  matchesQuery,
  pendingRouteOf,
  supportIntakeKey,
} from '../src/index.js'

const T0 = '2026-09-27T02:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }
const ME = 'hello@shop.example'

const verdict = (over: Partial<MessageTriage>): MessageTriage => ({
  route: 'inbox',
  labels: [],
  needs_reply: false,
  priority: 'normal',
  summary: '',
  confidence: 0.9,
  by: 'model',
  reasons: [],
  at: T0,
  ...over,
})

describe('WP167 intakeOf：一封分拣过的信接下来去哪一路', () => {
  it('客服 → support；红人 → kol；其余只进消息页', () => {
    expect(intakeOf({ triage: verdict({ route: 'support' }), folder_kind: 'inbox' })).toBe(
      'support',
    )
    expect(intakeOf({ triage: verdict({ route: 'kol' }), folder_kind: 'inbox' })).toBe('kol')
    // 订阅 / 通知：规则层判成 inbox，不开事项
    expect(
      intakeOf({ triage: verdict({ route: 'inbox', by: 'rule' }), folder_kind: 'inbox' }),
    ).toBe('none')
  })

  it('把握不够（挂了 suggested_route）→ 待确认；人判过的不再待确认', () => {
    const shy = verdict({ route: 'inbox', suggested_route: 'support', confidence: 0.4 })
    expect(intakeOf({ triage: shy, folder_kind: 'inbox' })).toBe('pending')
    expect(intakeOf({ triage: { ...shy, by: 'user' }, folder_kind: 'inbox' })).toBe('none')
  })

  it('已发 / 草稿 / 垃圾箱里的信一律不交', () => {
    for (const kind of ['sent', 'drafts', 'trash'] as const) {
      expect(intakeOf({ triage: verdict({ route: 'support' }), folder_kind: kind })).toBe('none')
    }
  })
})

describe('WP167 同一封信只进一次客服管线', () => {
  it('钥匙按 Message-ID（不分邮箱、不分大小写）；没有才按邮箱 × 文件夹 × UID', () => {
    const a = supportIntakeKey({ account: ME, message_id: '<M-1@x>', folder: 'INBOX', uid: 3 })
    const b = supportIntakeKey({
      account: 'other@shop.example',
      message_id: '<m-1@x>',
      folder: 'KefuAgents',
      uid: 90,
    })
    expect(a).toBe(b)
    expect(supportIntakeKey({ account: ME, folder: 'INBOX', uid: 3 })).toBe(`uid:${ME}|INBOX|3`)
  })

  it('内存档与 SQLite 档：记过的就认得，重复记不报错', () => {
    const memory = new MemorySupportIntakeLedger()
    const stores = createSqliteChannelStores({ clock })
    for (const ledger of [memory, stores.intake]) {
      expect(ledger.has('mid:<m-1@x>')).toBe(false)
      ledger.add('mid:<m-1@x>', T0)
      ledger.add('mid:<m-1@x>', T0)
      expect(ledger.has('mid:<m-1@x>')).toBe(true)
    }
    expect(stores.queue.schemaVersion).toBeGreaterThanOrEqual(5)
    stores.close()
  })
})

const record = (over: Partial<MessageRecord>): MessageRecord =>
  ({
    id: 'msg_1',
    workspace_id: 'ws_1',
    source: 'email',
    account: ME,
    folder: 'INBOX',
    folder_kind: 'inbox',
    thread_id: 't1',
    references: [],
    headers: {},
    from: { email: 'ann@customer.example' },
    to: [{ email: ME }],
    cc: [],
    bcc: [],
    subject: 's',
    snippet: '',
    text: '',
    has_remote_images: false,
    attachments: [],
    date: T0,
    received_at: T0,
    flags: { read: false, starred: false, answered: false, draft: false },
    labels: [],
    route: 'inbox',
    ...over,
  }) as MessageRecord

describe('WP167 「待确认」那一栏', () => {
  it('只收挂了 suggested_route、还在收件箱那条路上、人没判过的', () => {
    const shy = record({ triage: verdict({ suggested_route: 'support', confidence: 0.4 }) })
    const sure = record({ id: 'msg_2', route: 'support', triage: verdict({ route: 'support' }) })
    const judged = record({
      id: 'msg_3',
      triage: verdict({ suggested_route: 'support', by: 'user' }),
    })
    expect(pendingRouteOf(shy)).toBe('support')
    expect(pendingRouteOf(sure)).toBeUndefined()
    expect(pendingRouteOf(judged)).toBeUndefined()
    expect([shy, sure, judged].filter((m) => matchesQuery(m, { pending_route: true }))).toEqual([
      shy,
    ])
  })

  it('会话那一行带得出「想去哪」与那封信的 id', () => {
    const shy = record({ triage: verdict({ suggested_route: 'support', confidence: 0.4 }) })
    const [row] = aggregateThreads([shy])
    expect(row?.suggested_route).toBe('support')
    expect(row?.pending_message_id).toBe('msg_1')
    const [plain] = aggregateThreads([record({})])
    expect(plain?.suggested_route).toBeUndefined()
  })
})

describe('WP167 消息同步把原信与邮箱地址递给宿主', () => {
  it('handoff 拿得到原始 MIME；开关按邮箱现查', async () => {
    const source = [
      'From: ann@customer.example',
      `To: ${ME}`,
      'Subject: hi',
      'Message-ID: <m-9@customer.example>',
      'Date: Sat, 26 Sep 2026 10:00:00 +0000',
      '',
      'body',
      '',
    ].join('\r\n')
    const inbox: RawEmailMessage[] = [{ uid: 9, mailbox: 'INBOX', source }]
    const folder: MailSource = {
      fetchSince: async (since) => inbox.filter((m) => m.uid > since),
      health: async () => ({ ok: true }),
    }
    const handed: (RawEmailMessage | undefined)[] = []
    const asked: string[] = []
    const sync = new MailboxSync({
      clock,
      workspace_id: 'ws_1',
      store: new MemoryMessageStore(),
      state: new MemoryMailboxStateStore(),
      accounts: () => [{ address: ME, folders: ['INBOX'], open: () => folder }],
      triage: async () => verdict({ route: 'support' }),
      handoff: async (_r, _t, raw) => {
        handed.push(raw)
        return true
      },
      support_mailbox: (account) => {
        asked.push(account)
        return { shadow_mode: true }
      },
    })
    await sync.sync()
    expect(handed.map((r) => r?.uid)).toEqual([9])
    expect(handed[0]?.source).toContain('Message-ID: <m-9@customer.example>')
    expect(asked).toEqual([ME])
  })
})

describe('WP167 顺手修：noreply 发件人第 ③ 层真能命中', () => {
  it('光秃秃的 noreply@ / no-reply@ / 带前缀的 shop.noreply@ 都算机器信；普通地址不算', () => {
    const at = (from_email: string) =>
      isAutomatedMail({
        from_email,
        subject: 's',
        text: '',
        thread_id: 't',
        references: [],
        headers: {},
        has_attachments: false,
      })
    expect(at('noreply@notify.example')).toBe('noreply 发件人')
    expect(at('no-reply@shop.example')).toBe('noreply 发件人')
    expect(at('shop.noreply@x.example')).toBe('noreply 发件人')
    expect(at('ann@customer.example')).toBeUndefined()
    expect(at('knoreply@x.example')).toBeUndefined()
  })
})
