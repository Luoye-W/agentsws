/**
 * WP167：收信只走一个入口（docs/63 §D「收信一个入口」）。
 *
 * 按服务进程的装配把渠道与消息同步接在同一只替身邮箱上（不联网）：
 * 渠道 `inbox_intake: 'message_sync'`（不再自己轮询 INBOX），消息同步 `intakeSupport` 指向
 * `channels.intakeSupportMail`。一拍 = 先渠道、再消息同步（`server.ts` 的 `registerMailPoll`）。
 *
 * 钉住的几件事：
 * - 订阅 / 通知 / 供应商信：只进「消息」页，不开事项、不起 Run、不过判断层；
 * - 客服信：开一条事项、过一次判断层、起一次 Run，挪进 KefuAgents；
 * - 同一封信只进一次客服管线（两拍、挪走后换了 UID、同一 Message-ID 再来一封）；
 * - 判不准的：不开事项，进「待确认」；人点「这是客服」才交出去（写事件）；
 * - 邮箱卡上的开关：改了写事件、下一封就按新的走；
 * - 只装渠道的老调用方：老行为（适配器自己轮询，每封新信开事项）。
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
const ACTOR = { workspace_id: WS, person_id: 'p_owner', assignment_id: 'asg_1' }
const account: MailAccount = {
  connection_id: 'conn_mail',
  address: ME,
  imap: { host: 'localhost', port: 143, secure: false, user: ME, connection_id: 'conn_mail' },
  smtp: { host: 'localhost', port: 25, secure: false, user: ME, connection_id: 'conn_mail' },
}

const mime = (n: number, from: string, headers: string[] = [], mid = `m-${n}`): string =>
  [
    `From: ${from}`,
    `To: ${ME}`,
    `Subject: letter ${n}`,
    `Message-ID: <${mid}@mail.example>`,
    'Date: Sat, 26 Sep 2026 10:00:00 +0000',
    ...headers,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `body ${n}`,
    '',
  ].join('\r\n')

const NEWSLETTER = ['List-Unsubscribe: <mailto:unsub@news.example>']

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

/** 模型桩：走到模型这一层的信按 `confidence` 判成客服（群发信在规则层就被拦下）。 */
const modelSaying = (confidence: number): ModelGateway =>
  ({
    async complete() {
      return {
        text: JSON.stringify({
          route: 'support',
          labels: [],
          needs_reply: true,
          priority: 'high',
          summary: '客户问包裹',
          confidence,
        }),
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'stub' },
        static_prefix_hash: '',
      }
    },
  }) as unknown as ModelGateway

function assemble(over: {
  box: Mailbox
  roles?: RoleId[]
  confidence?: number
  /** `channel` = 只装渠道的老调用方（没有消息同步）。 */
  mode?: 'server' | 'channel'
}) {
  const events: EventEnvelope[] = []
  const appendEvent = (e: unknown): void => void events.push(e as EventEnvelope)
  const work = createWork({ workspace_id: WS, clock, random: () => 0.5 })
  const position = () => ({ person_id: 'p_owner', assignment_id: 'asg_1', role_id: 'dtc.support' })
  const runs: string[] = []
  const judged: string[] = []
  const server = (over.mode ?? 'server') === 'server'
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
    startRun: ({ matter }) => {
      runs.push(matter.id)
      return { run_id: `run_${runs.length}` }
    },
    judgeInbound: (input) => {
      judged.push(input.thread_id)
      return undefined
    },
    ...(server
      ? { mailbox_moves: 'message_sync' as const, inbox_intake: 'message_sync' as const }
      : {}),
  })
  const messages = server
    ? createMessages({
        clock,
        workspace_id: WS,
        appendEvent,
        halt: new MemoryHalt({}),
        accounts: () => [account],
        credentials: { password: () => 'pw' },
        work,
        position,
        activeRoles: () => over.roles ?? ['dtc.support'],
        models: modelSaying(over.confidence ?? 0.95),
        rawStore: channels.raw,
        makeSource: (_a, folder) => over.box.source(folder),
        makeWriter: () => over.box.writer(),
        listFolders: async () => [...over.box.folders.keys()],
        intakeSupport: (input) => channels.intakeSupportMail(input),
      })
    : undefined
  const tick = async (): Promise<void> => {
    await channels.poll()
    await messages?.poll()
  }
  const matters = () => work.listMatters({ kind: 'conversation' })
  const ofType = (type: string) => events.filter((e) => e.type === type)
  return { channels, messages, tick, events, runs, judged, matters, ofType }
}

describe('WP167：收信一个入口（服务进程的装配）', () => {
  it('订阅 / 通知信只进消息页：不开事项、不起 Run、不过判断层；客服信开一条、起一次', async () => {
    const box = new Mailbox()
    box.deliver(1, mime(1, 'promo@news.example', NEWSLETTER))
    box.deliver(2, mime(2, 'noreply@notify.example'))
    box.deliver(3, mime(3, 'ann@customer.example'))
    const h = assemble({ box })
    await h.tick()
    expect(h.matters()).toHaveLength(1)
    expect(h.runs).toHaveLength(1)
    expect(h.judged).toHaveLength(1)
    // 三封都在消息库里看得见
    expect((await h.messages?.store.list({}))?.length).toBe(3)
    expect(box.where('m-1')).toEqual({ folder: 'INBOX', read: false })
    expect(box.where('m-2')).toEqual({ folder: 'INBOX', read: false })
    expect(box.where('m-3')).toEqual({ folder: 'KefuAgents', read: true })
    // 消息库里那封客服信挂上了那条事项
    const row = (await h.messages?.store.list({}))?.find(
      (m) => m.message_id === '<m-3@mail.example>',
    )
    expect(row?.linked).toEqual({ type: 'matter', id: h.matters()[0]?.id })
  })

  it('同一封信只进一次客服管线：两拍、挪走换了 UID、同一 Message-ID 再来一封都不再起 Run', async () => {
    const box = new Mailbox()
    box.deliver(3, mime(3, 'ann@customer.example'))
    const h = assemble({ box })
    await h.tick()
    await h.tick()
    // 同一封信（同一 Message-ID）又从收件箱里冒出来一次（比如人在手机上挪回来了）
    box.deliver(4, mime(3, 'ann@customer.example'))
    await h.tick()
    expect(h.runs).toHaveLength(1)
    expect(h.judged).toHaveLength(1)
    // 直接再递一次：台账认得它，回 duplicate，一条 Run 都不多
    const again = await h.channels.intakeSupportMail({
      account: ME,
      raw: { uid: 3, mailbox: 'INBOX', source: mime(3, 'ann@customer.example') },
      message_id: '<m-3@mail.example>',
      by: 'triage',
    })
    expect(again).toMatchObject({ accepted: true, duplicate: true })
    expect(h.runs).toHaveLength(1)
  })

  it('客服岗位没开：客服信也只进消息页，不开事项、不挪', async () => {
    const box = new Mailbox()
    box.deliver(3, mime(3, 'ann@customer.example'))
    const h = assemble({ box, roles: [] })
    await h.tick()
    expect(h.matters()).toHaveLength(0)
    expect(h.runs).toHaveLength(0)
    expect(box.where('m-3')).toEqual({ folder: 'INBOX', read: false })
  })

  it('只装渠道的老调用方：适配器照旧自己轮询 INBOX，每封新信都开事项', async () => {
    const box = new Mailbox()
    box.deliver(1, mime(1, 'promo@news.example', NEWSLETTER))
    box.deliver(3, mime(3, 'ann@customer.example'))
    const h = assemble({ box, mode: 'channel' })
    await h.tick()
    expect(h.matters()).toHaveLength(2)
    expect(h.runs).toHaveLength(2)
  })
})

describe('WP167：判不准的放「待确认」，人点一下才交出去', () => {
  it('低把握的客服判定：不开事项、不挪；进待确认；点「这是客服」→ 开事项、起 Run、挪信、写事件', async () => {
    const box = new Mailbox()
    box.deliver(3, mime(3, 'ann@customer.example'))
    const h = assemble({ box, confidence: 0.4 })
    await h.tick()
    expect(h.matters()).toHaveLength(0)
    expect(h.runs).toHaveLength(0)
    expect(box.where('m-3')).toEqual({ folder: 'INBOX', read: false })
    const port = h.messages?.port
    const pending = (await port?.threads(ACTOR, { pending_route: true }))?.threads ?? []
    expect(pending).toHaveLength(1)
    expect(pending[0]?.suggested_route).toBe('support')
    const id = pending[0]?.pending_message_id as string

    const out = await port?.confirmRoute?.(ACTOR, id, { route: 'support' })
    expect(out?.handed_off).toBe(true)
    expect(out?.matter_id).toBe(h.matters()[0]?.id)
    expect(h.runs).toHaveLength(1)
    expect(h.judged).toHaveLength(1)
    expect(box.where('m-3')).toEqual({ folder: 'KefuAgents', read: true })
    expect(out?.message.route).toBe('support')
    expect(out?.message.triage?.by).toBe('user')
    // 待确认里没它了
    expect((await port?.threads(ACTOR, { pending_route: true }))?.threads).toHaveLength(0)
    // 人工分拣写了事件：谁点的、判成什么；没有正文、地址遮过
    const confirmed = h.ofType('messages.route_confirmed')
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]?.actor).toEqual({ kind: 'person', id: 'p_owner' })
    expect(confirmed[0]?.payload).toMatchObject({ route: 'support', handed_off: true })
    expect(JSON.stringify(confirmed)).not.toContain('body 3')
    expect(JSON.stringify(confirmed)).not.toContain('ann@customer.example')

    // 再点一次：同一封信不再进客服管线
    await port?.confirmRoute?.(ACTOR, id, { route: 'support' })
    expect(h.runs).toHaveLength(1)
  })

  it('点「不是」：只记人的判断，信留在收件箱，从待确认里消失', async () => {
    const box = new Mailbox()
    box.deliver(3, mime(3, 'ann@customer.example'))
    const h = assemble({ box, confidence: 0.4 })
    await h.tick()
    const port = h.messages?.port
    const id = (await port?.threads(ACTOR, { pending_route: true }))?.threads[0]
      ?.pending_message_id as string
    const out = await port?.confirmRoute?.(ACTOR, id, { route: 'inbox' })
    expect(out?.handed_off).toBe(false)
    expect(h.matters()).toHaveLength(0)
    expect(box.where('m-3')).toEqual({ folder: 'INBOX', read: false })
    expect((await port?.threads(ACTOR, { pending_route: true }))?.threads).toHaveLength(0)
    expect(h.ofType('messages.route_confirmed')[0]?.payload).toMatchObject({ route: 'inbox' })
  })

  it('客服岗位没开时点「这是客服」：交不出去，什么都不改，照实回', async () => {
    const box = new Mailbox()
    box.deliver(3, mime(3, 'ann@customer.example'))
    const roles: RoleId[] = ['dtc.support']
    const h = assemble({ box, confidence: 0.4, roles })
    await h.tick()
    roles.length = 0
    const port = h.messages?.port
    const id = (await port?.threads(ACTOR, { pending_route: true }))?.threads[0]
      ?.pending_message_id as string
    const out = await port?.confirmRoute?.(ACTOR, id, { route: 'support' })
    expect(out?.handed_off).toBe(false)
    expect(h.runs).toHaveLength(0)
    expect((await port?.threads(ACTOR, { pending_route: true }))?.threads).toHaveLength(1)
  })
})

describe('WP167：邮箱卡上的开关', () => {
  it('默认值照老产品；改影子模式写一条事件，下一封客服信就只看不动（照样开事项）', async () => {
    const box = new Mailbox()
    const h = assemble({ box })
    const sw = h.messages?.switches
    expect(sw?.get(ME)).toEqual({ shadow_mode: false, move: true, mark_read: true, takeover: true })
    expect(sw?.set(ME, { shadow_mode: true }, 'p_owner')).toMatchObject({ shadow_mode: true })
    // 没变的不写事件
    sw?.set(ME, { shadow_mode: true }, 'p_owner')
    const changed = h.ofType('mailbox.switches_changed')
    expect(changed).toHaveLength(1)
    expect(changed[0]?.payload).toMatchObject({ changed: { shadow_mode: true } })
    expect(JSON.stringify(changed)).not.toContain(ME)

    box.deliver(3, mime(3, 'ann@customer.example'))
    await h.tick()
    expect(h.runs).toHaveLength(1)
    expect(box.where('m-3')).toEqual({ folder: 'INBOX', read: false })

    // 关掉影子模式、关掉挪信：下一封只标已读
    sw?.set(ME, { shadow_mode: false, move: false }, 'p_owner')
    box.deliver(4, mime(4, 'bob@customer.example'))
    await h.tick()
    expect(box.where('m-4')).toEqual({ folder: 'INBOX', read: true })
  })

  it('接管 = 客服岗位开着（只读）', () => {
    const h = assemble({ box: new Mailbox(), roles: [] })
    expect(h.messages?.switches.get(ME).takeover).toBe(false)
  })
})

describe('WP167：开关落盘', () => {
  it('按邮箱各存一份（地址不分大小写），重开还在；坏文件按默认值走', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { MailboxSwitchStore } = await import('../src/mailbox-switches.js')
    const dir = mkdtempSync(join(tmpdir(), 'wp167-switches-'))
    try {
      const a = new MailboxSwitchStore({ dir })
      expect(a.set('Hello@Shop.example', { mark_read: false }).changed).toEqual(['mark_read'])
      const b = new MailboxSwitchStore({ dir })
      expect(b.get(ME)).toEqual({ shadow_mode: false, move: true, mark_read: false })
      expect(b.get('other@shop.example').mark_read).toBe(true)
      writeFileSync(join(dir, 'mailbox-switches.json'), '{oops')
      expect(new MailboxSwitchStore({ dir }).get(ME).mark_read).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('WP167 终审追加：升级那一拍预写台账', () => {
  it('老版本已处理的信（事项钉着的、适配器游标之前的）升级后第一次扫描 0 事项 0 Run；游标之后的新客户信照常 1 事项 1 Run', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'wp167-upgrade-'))
    // 时钟可拨：升级在两天之后（入站管线自己那张去重表只管 24h，挡不住这一拍）
    let now = T0
    const clk: Clock = { now: () => now, sleep: async () => undefined }
    const box = new Mailbox()
    const work = createWork({ workspace_id: WS, clock: clk, random: () => 0.5 })
    const position = () => ({
      person_id: 'p_owner',
      assignment_id: 'asg_1',
      role_id: 'dtc.support',
    })
    const runs: string[] = []
    const events: EventEnvelope[] = []
    const appendEvent = (e: unknown): void => void events.push(e as EventEnvelope)
    const channelsWith = (mode: 'old' | 'new') =>
      createChannels({
        clock: clk,
        workspace_id: WS,
        dbDir: dir,
        appendEvent,
        halt: new MemoryHalt({}),
        accounts: () => [account],
        credentials: { password: () => 'pw' },
        work,
        position,
        makeSource: () => box.source('INBOX'),
        startRun: ({ matter }) => {
          runs.push(matter.id)
          return { run_id: `run_${runs.length}` }
        },
        mailbox_moves: 'message_sync',
        ...(mode === 'new' ? { inbox_intake: 'message_sync' as const } : {}),
      })
    try {
      // ── 老版本：渠道那一路自己扫 INBOX，每封新信开事项、起 Run（消息同步这一拍还没跑到它们）
      box.deliver(1, mime(1, 'ann@customer.example'))
      box.deliver(2, mime(2, 'bob@customer.example'))
      box.deliver(3, mime(3, 'promo@news.example', NEWSLETTER))
      // 第一封的后续来信：它的 Message-ID 不是线程 id，事项钉着的线程认不出它——只能靠适配器游标认
      box.deliver(
        5,
        mime(5, 'ann@customer.example', [
          'In-Reply-To: <m-1@mail.example>',
          'References: <m-1@mail.example>',
        ]),
      )
      const old = channelsWith('old')
      await old.poll()
      expect(runs).toHaveLength(4)
      expect(work.listMatters({ kind: 'conversation' })).toHaveLength(3)
      await old.close()
      // 人在手机上把第二封挪进了垃圾邮件（换了文件夹、换了 UID：适配器游标认不出它，只能靠事项钉着的线程认）
      box.writer().move('INBOX', 2, 'Junk')

      // ── 升级：收信只走消息同步
      now = '2026-09-29T02:00:00.000Z'
      const channels = channelsWith('new')
      const messages = createMessages({
        clock: clk,
        workspace_id: WS,
        dbDir: dir,
        appendEvent,
        halt: new MemoryHalt({}),
        accounts: () => [account],
        credentials: { password: () => 'pw' },
        work,
        position,
        activeRoles: () => ['dtc.support'],
        models: modelSaying(0.95),
        rawStore: channels.raw,
        makeSource: (_a, folder) => box.source(folder),
        makeWriter: () => box.writer(),
        listFolders: async () => [...box.folders.keys()],
        intakeSupport: (input) => channels.intakeSupportMail(input),
        seedSupportIntake: (marker, keys) => channels.seedSupportIntake(marker, keys),
      })
      const tick = async (): Promise<void> => {
        await channels.poll()
        await messages.poll()
      }
      await tick()
      // 第一次扫描：四封老信都进了消息库，一条事项、一次 Run 都没多
      expect((await messages.store.list({})).length).toBe(4)
      expect(runs).toHaveLength(4)
      expect(work.listMatters({ kind: 'conversation' })).toHaveLength(3)
      // 那封后续来信是按适配器游标认出来的"老信"
      expect(
        events.some(
          (e) =>
            e.type === 'inbound.support_intake' &&
            (e.payload as { legacy?: boolean }).legacy === true,
        ),
      ).toBe(true)
      const seeded = events.filter((e) => e.type === 'inbound.support_intake_seeded')
      expect(seeded).toHaveLength(1)
      // 事件里只有条数，没有 Message-ID
      expect(JSON.stringify(seeded)).not.toContain('mail.example')

      // 游标之后的新客户信：照常一条事项、一次 Run
      box.deliver(6, mime(6, 'carol@customer.example'))
      await tick()
      expect(runs).toHaveLength(5)
      expect(work.listMatters({ kind: 'conversation' })).toHaveLength(4)

      // 只做一次：再起一遍新装配，台账里有标记，不再算第二遍
      await channels.close()
      messages.close()
      const again = channelsWith('new')
      const out = await again.seedSupportIntake('meta:wp167_legacy_seed_v1', () => {
        throw new Error('不该再算一遍')
      })
      expect(out).toEqual({ already: true, seeded: 0 })
      await again.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
