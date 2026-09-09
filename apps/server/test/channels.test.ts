/**
 * 39 待办 C：渠道在**服务进程**里真装配起来。
 *
 * 收信这一路跑的是真链路：真 `imapflow` → channels 包的最小 IMAP 协议桩
 * → 真适配器 → 真入站管线 → 真受控原始材料区（接 `@agentsws/data` 的主体密钥环）
 * → 工作模型的事项 → `startRun`。发信端注入一个记录用的 `Mailer`
 * （`smtp-server` 是 channels 包的开发依赖，从 apps/server 引不到）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Mailer, OutboundMail } from '@agentsws/channels'
import type { ApprovalItem, Clock, EventEnvelope, Matter } from '@agentsws/contracts'
import { createDataStore, type SqliteDataStore } from '@agentsws/data'
import { MemoryHalt } from '@agentsws/kernel'
import { createWork, type Work } from '@agentsws/work'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type FakeImapServer,
  startFakeImapServer,
} from '../../../packages/channels/test/fake-imap-server.js'
import type { MailAccount } from '../src/index.js'
import { type ChannelsAssembly, createChannels, forDisplay, OUTBOUND_HALTED } from '../src/index.js'

const USER = 'support@shop.example'
const PASS = 'app-specific-password'
const WS = 'ws_1'
const T0 = '2026-09-10T00:00:00.000Z'
const SECRET_LINE = '我的授权码：abcdefghijklmnop'
const ADDRESS = 'Torstrasse 12, Berlin'

const clock: Clock = { now: () => T0, sleep: async () => undefined }

function mime(over: {
  from?: string
  message_id?: string
  subject?: string
  text?: string
}): string {
  return [
    `From: ${over.from ?? 'ann@customer.com'}`,
    `To: ${USER}`,
    `Subject: ${over.subject ?? 'Where is order #1042?'}`,
    'Date: Wed, 09 Sep 2026 07:55:00 +0000',
    `Message-ID: ${over.message_id ?? '<m-1@mail.example>'}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    (over.text ?? `订单 #1042 还没到，寄到 ${ADDRESS}。${SECRET_LINE}`).replace(/\n/g, '\r\n'),
    '',
  ].join('\r\n')
}

/** 记录发出去的信；不连真 SMTP。 */
class RecordingMailer implements Mailer {
  readonly sent: OutboundMail[] = []
  async send(mail: OutboundMail): Promise<{ message_id: string }> {
    this.sent.push(mail)
    return { message_id: mail.message_id ?? '<sent@shop.example>' }
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
}

let imap: FakeImapServer

beforeAll(async () => {
  imap = await startFakeImapServer({
    user: USER,
    pass: PASS,
    messages: [{ uid: 1, source: mime({}) }],
  })
})

afterAll(async () => {
  await imap.close()
})

const cleanup: (() => void)[] = []
const assemblies: ChannelsAssembly[] = []

afterEach(async () => {
  for (const a of assemblies.splice(0)) await a.close()
  for (const fn of cleanup.splice(0)) fn()
})

function account(over: Partial<MailAccount> = {}): MailAccount {
  const connection_id = over.connection_id ?? 'conn_mail_1'
  return {
    connection_id,
    address: USER,
    imap: { host: '127.0.0.1', port: imap.port, secure: false, user: USER, connection_id },
    smtp: { host: '127.0.0.1', port: 2525, secure: false, user: USER, connection_id },
    ...over,
  }
}

interface Harness {
  channels: ChannelsAssembly
  work: Work
  data: SqliteDataStore
  halt: MemoryHalt
  mailer: RecordingMailer
  events: EventEnvelope[]
  runs: { matter: Matter; brief: string }[]
  dir: string
  accounts: MailAccount[]
}

function harness(over: { accounts?: MailAccount[]; cipher?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-channels-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const data = createDataStore({ dbPath: join(dir, 'data.db'), clock, collections: [] })
  cleanup.push(() => data.close())
  const halt = new MemoryHalt({})
  const events: EventEnvelope[] = []
  const runs: { matter: Matter; brief: string }[] = []
  const work = createWork({ workspace_id: WS, clock, random: () => 0.5 })
  const mailer = new RecordingMailer()
  const accounts = over.accounts ?? [account()]
  const channels = createChannels({
    clock,
    workspace_id: WS,
    dbDir: dir,
    halt,
    appendEvent: (e) => {
      events.push(e as EventEnvelope)
    },
    // 18 §2.1 第一条纪律：不传这一行，邮件原文就是明文落盘
    ...(over.cipher === false ? {} : { cipher: data.keyring }),
    accounts: () => accounts,
    credentials: { password: () => PASS },
    work,
    position: () => ({ person_id: 'p_owner', assignment_id: 'asg_1', role_id: 'dtc.aftersales' }),
    startRun: (input) => {
      runs.push({ matter: input.matter, brief: input.brief })
      return { run_id: `run_${runs.length}` }
    },
    makeMailer: () => mailer,
  })
  assemblies.push(channels)
  return { channels, work, data, halt, mailer, events, runs, dir, accounts }
}

describe('IMAP 轮询 → 入站管线 → 岗位事项 → 起 Run（39 待办 C）', () => {
  it('拉一轮就把来信落成一条事项并起 Run；秘密不进事件、正文带围栏', async () => {
    const h = harness()
    const report = await h.channels.poll()
    expect(report).toMatchObject({ accounts: 1, messages: 1, failed: [] })

    // 事项：一条 conversation，钉着这条线程
    const matters = h.work.listMatters({ kind: 'conversation' })
    expect(matters).toHaveLength(1)
    expect(matters[0]?.context.pinned[0]?.type).toBe('thread')

    // 起了一次 Run，brief 是围栏里的正文（模型看到的是围栏内文本）
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]?.brief).toContain('<external_data>')
    // 秘密在进事件之前就换成了占位符（18 §5 用例 3）
    expect(h.runs[0]?.brief).not.toContain('abcdefghijklmnop')
    expect(h.runs[0]?.brief).toContain('[redacted:mail_app_password]')

    const received = h.events.find((e) => e.type === 'inbound.received')
    expect(received?.payload).toMatchObject({ secrets_scrubbed: true })
    expect(JSON.stringify(h.events)).not.toContain('abcdefghijklmnop')
    // 口令一个字节都不进事件
    expect(JSON.stringify(h.events)).not.toContain(PASS)
  })

  it('同一封信再拉一次不重复出事项（去重 24h 窗口）', async () => {
    const h = harness()
    await h.channels.poll()
    // 适配器按 UID 增量拉，这里直接把同一条再喂一遍去撞去重表
    await h.channels.poll()
    expect(h.work.listMatters({ kind: 'conversation' })).toHaveLength(1)
    expect(h.runs).toHaveLength(1)
  })

  it('原始材料区接了 data.keyring：库文件字节里找不到正文（18 §2.1）', async () => {
    const h = harness()
    await h.channels.poll()
    const files = readdirSync(h.dir).filter((f) => f.startsWith('channels-raw'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      expect(readFileSync(join(h.dir, f)).toString('latin1')).not.toContain(ADDRESS)
    }
  })

  it('反向哨兵：不接密钥环就是明文落盘——所以装配那一行漏不得', async () => {
    const h = harness({ cipher: false })
    await h.channels.poll()
    const bytes = readdirSync(h.dir)
      .filter((f) => f.startsWith('channels-raw'))
      .map((f) => readFileSync(join(h.dir, f)).toString('latin1'))
      .join('')
    expect(bytes).toContain(ADDRESS)
  })
})

describe('出站发信（18 §3）', () => {
  const draft = (thread: string, text = '已经补寄了，单号 SF123。'): ApprovalItem =>
    ({
      id: 'apr_1',
      kind: 'outbound_draft',
      payload: { channel: 'email', thread_ref: thread, body: { text } },
    }) as unknown as ApprovalItem

  it('批准的回信真发出去，收件人只从线程台账取', async () => {
    const h = harness()
    await h.channels.poll()
    const out = await h.channels.deliver(draft('<m-1@mail.example>'), { idempotencyKey: 'chg_1' })
    expect(out).toMatchObject({ status: 'ok' })
    expect(h.mailer.sent).toHaveLength(1)
    expect(h.mailer.sent[0]?.to).toEqual(['ann@customer.com'])
  })

  it('急停 outbound 档挡住发信（对账没完 / 人按了暂停都走这一条）', async () => {
    const h = harness()
    await h.channels.poll()
    h.halt.set('outbound', true, '测试')
    const out = await h.channels.deliver(draft('<m-1@mail.example>'), { idempotencyKey: 'chg_2' })
    expect(out).toMatchObject({ status: 'failed', error: { message: OUTBOUND_HALTED } })
    expect(h.mailer.sent).toHaveLength(0)
    // 放开之后同一条就发得出去
    h.halt.set('outbound', false)
    expect(
      await h.channels.deliver(draft('<m-1@mail.example>'), { idempotencyKey: 'chg_2' }),
    ).toMatchObject({ status: 'ok' })
  })

  it('不是邮件 / 没有线程的卡不归渠道管，交回给调用方', async () => {
    const h = harness()
    expect(
      await h.channels.deliver(
        {
          id: 'a',
          kind: 'outbound_draft',
          payload: { channel: 'whatsapp' },
        } as unknown as ApprovalItem,
        { idempotencyKey: 'k' },
      ),
    ).toBeUndefined()
    expect(
      await h.channels.deliver(
        {
          id: 'a',
          kind: 'outbound_draft',
          payload: { channel: 'email' },
        } as unknown as ApprovalItem,
        { idempotencyKey: 'k' },
      ),
    ).toBeUndefined()
  })

  it('收件人门禁拒发的不重试（不是网络抖了）', async () => {
    const h = harness()
    await h.channels.poll()
    const out = await h.channels.deliver(draft('<unknown-thread@x>'), { idempotencyKey: 'chg_3' })
    expect(out).toMatchObject({ status: 'failed', error: { retryable: false } })
  })
})

describe('热更新与保留期', () => {
  it('连接页新增 / 断开邮箱之后 refresh 就换成新的那一份', async () => {
    const h = harness({ accounts: [] })
    expect(h.channels.addresses()).toEqual([])
    expect(await h.channels.poll()).toMatchObject({ accounts: 0, messages: 0 })

    h.accounts.push(account())
    h.channels.refresh()
    expect(h.channels.addresses()).toEqual([USER])

    h.accounts.length = 0
    h.channels.refresh()
    expect(h.channels.addresses()).toEqual([])
  })

  it('保留期：过期的原始材料清掉；随主体删除按发件人地址', async () => {
    const h = harness()
    await h.channels.poll()
    // 保留 90 天，材料是今天落的 → 一条都不清
    expect(await h.channels.prune(90 * 86_400_000, T0)).toBe(0)
    const erased = await h.channels.eraseSubject('ann@customer.com')
    expect(erased.rows).toBeGreaterThan(0)
    expect(erased.shredded_at).toBeTruthy()
  })

  it('一个邮箱连不上不拖垮别的（拉不动的进 failed，不抛）', async () => {
    const broken = account({ connection_id: 'conn_dead', address: 'dead@shop.example' })
    broken.imap = { ...broken.imap, port: 1 }
    const h = harness({ accounts: [account(), broken] })
    const report = await h.channels.poll()
    expect(report.accounts).toBe(2)
    expect(report.messages).toBe(1)
    expect(report.failed).toHaveLength(1)
  })
})

describe('forDisplay', () => {
  it('时间线上那一行去掉围栏标记并压空白', () => {
    expect(forDisplay('<external_data>\n  订单 #1042\n 还没到\n</external_data>')).toBe(
      '订单 #1042 还没到',
    )
  })

  it('太长的截断加省略号', () => {
    expect(forDisplay('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})
