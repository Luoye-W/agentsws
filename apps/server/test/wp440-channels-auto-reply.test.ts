/**
 * WP440（docs/108 M9）：渠道这一跳的接线——判断层说完、起 Run 之前问「能不能直接回」：
 * 直接回了 → 不起 Run；拦下已退回成卡 → 不起 Run；没直接回 → 照旧起 Run；钩子自己炸了 → 照旧起 Run。
 * 判断层不是 auto_reply（handoff）时不问。
 */
import type { MailboxWriter, MailSource } from '@agentsws/channels'
import type { Clock, EventEnvelope, RoleId } from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import { createWork } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import {
  createChannels,
  type EmailAutoReplyOutcome,
  type EmailAutoReplyRequest,
} from '../src/channels.js'
import type { MailAccount } from '../src/index.js'

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

/** 替身邮箱：文件夹 → 信。挪过去的信拿一个新 UID（IMAP 就是这样）。 */
class Mailbox {
  readonly folders = new Map<string, { uid: number; source: string; flags: Set<string> }[]>([
    ['INBOX', []],
  ])
  private next = 100
  deliver(uid: number, source: string): void {
    this.folders.get('INBOX')?.push({ uid, source, flags: new Set() })
  }
  where(mid: string): { folder: string; read: boolean } | undefined {
    for (const [folder, rows] of this.folders) {
      const row = rows.find((r) => r.source.includes(`<${mid}@`))
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
    }
  }
  writer(): MailboxWriter {
    return {
      setFlags: (folder, uid, add) => {
        const row = this.folders.get(folder)?.find((r) => r.uid === uid)
        if (add.includes('\\Seen')) row?.flags.add('\\Seen')
        return row !== undefined
      },
      move: (folder, uid, to) => {
        const rows = this.folders.get(folder) ?? []
        const at = rows.findIndex((r) => r.uid === uid)
        const row = rows[at]
        if (row === undefined) return false
        rows.splice(at, 1)
        const dest = this.folders.get(to) ?? []
        this.folders.set(to, dest)
        this.next += 1
        dest.push({ ...row, uid: this.next })
        return true
      },
      listFolders: () => [...this.folders.keys()],
    }
  }
}

function assemble(
  auto: (input: EmailAutoReplyRequest) => Promise<EmailAutoReplyOutcome | undefined>,
  action: 'auto_reply' | 'handoff' = 'auto_reply',
) {
  const events: EventEnvelope[] = []
  const work = createWork({ workspace_id: WS, clock, random: () => 0.5 })
  const runs: string[] = []
  const asked: EmailAutoReplyRequest[] = []
  const box = new Mailbox()
  const channels = createChannels({
    clock,
    workspace_id: WS,
    appendEvent: (e: unknown) => void events.push(e as EventEnvelope),
    halt: new MemoryHalt({}),
    accounts: () => [account],
    credentials: { password: () => 'pw' },
    work,
    position: () => ({
      person_id: 'p_owner',
      assignment_id: 'asg_1',
      role_id: 'dtc.support' as RoleId,
    }),
    makeSource: () => box.source('INBOX'),
    startRun: ({ matter }) => {
      runs.push(matter.id)
      return { run_id: `run_${runs.length}` }
    },
    judgeInbound: () => ({ action, note: '判断层的一句话' }),
    autoReply: async (input) => {
      asked.push(input)
      return auto(input)
    },
  })
  const notes = () =>
    work
      .listMatters({ kind: 'conversation' })
      .flatMap((m) => work.matterView(m.id, { limit: 50 }).timeline)
      .filter((e) => e.kind === 'note')
      .map((e) => e.text)
  return { box, channels, runs, asked, notes }
}

const LETTER = [
  'From: ann@customer.example',
  `To: ${ME}`,
  'Subject: 保修问题',
  'Message-ID: <m-1@mail.example>',
  'Date: Sat, 26 Sep 2026 10:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '请问充电类产品保修期多久？',
  '',
  '谢谢',
  '电话：138 0013 8000',
  '',
].join('\r\n')

describe('WP440：渠道这一跳——有把握就直接回', () => {
  it('直接回了：不起 Run，时间线写「AI 直接回」那一句；问的时候带上整封、邮箱、发件人', async () => {
    const h = assemble(async () => ({
      sent: true,
      approval_item_id: 'apr_1',
      note: 'AI 有把握，直接回了这一封 · 出处：保修。',
    }))
    h.box.deliver(1, LETTER)
    await h.channels.poll()
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]?.account).toBe(ME)
    expect(h.asked[0]?.text).toContain('138 0013 8000')
    expect(h.asked[0]?.text).toContain('\n')
    expect(h.asked[0]?.inbound_action).toBe('auto_reply')
    expect(h.runs).toHaveLength(0)
    expect(h.notes().join('')).toContain('直接回了这一封')
  })

  it('拦下已退回成卡：不再起 Run 重复出卡', async () => {
    const h = assemble(async () => ({
      sent: false,
      kind: 'outbound_blocked',
      card_id: 'apr_2',
      note: '退回成卡',
    }))
    h.box.deliver(1, LETTER)
    await h.channels.poll()
    expect(h.runs).toHaveLength(0)
  })

  it('没直接回：照旧起 Run（出卡在运行时那一跳）', async () => {
    const h = assemble(async () => ({ sent: false, kind: 'low_confidence' }))
    h.box.deliver(1, LETTER)
    await h.channels.poll()
    expect(h.runs).toHaveLength(1)
    expect(h.notes()).toContain('判断层的一句话')
  })

  it('钩子自己炸了：fail-closed，照旧起 Run、一封都不替人发', async () => {
    const h = assemble(async () => {
      throw new Error('boom')
    })
    h.box.deliver(1, LETTER)
    await h.channels.poll()
    expect(h.runs).toHaveLength(1)
  })

  it('handoff：不问、不起 Run（老行为）', async () => {
    const h = assemble(async () => ({ sent: true, approval_item_id: 'x', note: 'x' }), 'handoff')
    h.box.deliver(1, LETTER)
    await h.channels.poll()
    expect(h.asked).toHaveLength(0)
    expect(h.runs).toHaveLength(0)
  })
})
