/**
 * WP488（决策 1680 / 1686）：「从过往邮件学」按日期回看——不碰游标、不落库、不分拣。信是现编的。
 */
import type { Clock } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { MailSource, RawEmailMessage } from '../src/email/imap.js'
import { MailboxSync, MemoryMailboxStateStore, MemoryMessageStore } from '../src/index.js'

const T0 = '2026-10-23T02:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }
const ME = 'support@shop.example'

const raw = (uid: number, from: string, date: string, subject: string): RawEmailMessage => ({
  uid,
  mailbox: 'INBOX',
  source: `From: ${from}\r\nTo: ${ME}\r\nSubject: ${subject}\r\nDate: ${new Date(date).toUTCString()}\r\nMessage-ID: <m${uid}@x>\r\n\r\nHello ${uid}`,
  internal_date: date as never,
})

describe('MailboxSync.history', () => {
  it('收件箱 + 已发按日期回看；不落库、不分拣、不推游标；收信端不支持就照实说', async () => {
    const store = new MemoryMessageStore()
    const state = new MemoryMailboxStateStore()
    const asked: string[] = []
    let triaged = 0
    const source = (folder: string): MailSource => ({
      fetchSince: async () => [],
      health: async () => ({ ok: true }),
      ...(folder === 'Drafts'
        ? {}
        : {
            fetchSinceDate: async (since: string, limit: number) => {
              asked.push(`${folder}|${since}|${limit}`)
              return folder === 'INBOX'
                ? [raw(1, 'amy@cust.example', '2026-05-01T00:00:00Z', 'Refund?')]
                : [raw(2, ME, '2026-05-02T00:00:00Z', 'Re: Refund?')]
            },
          }),
    })
    const sync = new MailboxSync({
      clock,
      workspace_id: 'ws_1' as never,
      store,
      state,
      accounts: () => [{ address: ME, folders: ['INBOX', 'Sent', 'Drafts'], open: source }],
      triage: async () => {
        triaged += 1
        throw new Error('不该分拣')
      },
    })
    expect(sync.accounts()).toEqual([ME])
    const got = await sync.history(ME, '2025-10-23T02:00:00.000Z', { limit: 50 })
    expect(got.supported).toBe(true)
    expect(got.folders).toBe(2)
    expect(got.records.map((r) => r.from.email).sort()).toEqual(['amy@cust.example', ME])
    expect(asked).toEqual(['INBOX|2025-10-23T02:00:00.000Z|50', 'Sent|2025-10-23T02:00:00.000Z|50'])
    expect(await store.list({})).toHaveLength(0)
    expect(triaged).toBe(0)
    expect(await state.cursor(ME, 'INBOX')).toBeUndefined()
    expect((await sync.history('other@x', T0)).supported).toBe(false)
  })
})

describe('ImapMailSource.fetchSinceDate', () => {
  it('按日期搜、只取最新的 limit 封、升序；没有 search 的最小桩回空', async () => {
    const { ImapMailSource } = await import('../src/email/imap.js')
    const searched: unknown[] = []
    const fetched: string[] = []
    const client = {
      connect: async () => undefined,
      logout: async () => undefined,
      close: () => undefined,
      getMailboxLock: async () => ({ release: () => undefined }),
      search: async (q: unknown) => {
        searched.push(q)
        return [5, 3, 9, 7]
      },
      async *fetch(range: string) {
        fetched.push(range)
        for (const uid of range.split(',').map(Number))
          yield { uid, source: new TextEncoder().encode(`Subject: ${uid}\r\n\r\nx`) }
      },
    }
    const src = new ImapMailSource({
      config: { host: 'h', port: 993, secure: true, user: 'u', password_env: 'P' },
      env: { P: 'x' },
      createClient: () => client as never,
    })
    const out = await src.fetchSinceDate('2026-01-01T00:00:00.000Z', 2)
    expect(searched).toEqual([{ since: new Date('2026-01-01T00:00:00.000Z') }])
    expect(fetched).toEqual(['7,9'])
    expect(out.map((m) => m.uid)).toEqual([7, 9])
    const bare = new ImapMailSource({
      config: { host: 'h', port: 993, secure: true, user: 'u', password_env: 'P' },
      env: { P: 'x' },
      createClient: () => ({ ...client, search: undefined }) as never,
    })
    expect(await bare.fetchSinceDate('2026-01-01T00:00:00.000Z', 2)).toEqual([])
  })
})
