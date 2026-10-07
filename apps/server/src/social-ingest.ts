/**
 * WP256（决策 147）：「群里的帖子」自动进帖。
 *
 * 之前社媒库里只有经接口送进来的线程（`POST /v1/social/threads`），真用户打开「群里的帖子」多半是空的。
 * 这个文件补两条自动来源：
 *
 * | 渠道 | 怎么来 | 频率 |
 * |---|---|---|
 * | Discord | 已连上的机器人，对品牌登记的频道（`SocialAccount.external_id = <服务器id>/<频道id>`）读新消息 | 默认 15 分钟一次（可调 5 分钟–24 小时） |
 * | Reddit 自家版 | 复用 WP249 读版务队列那一次（`unmoderated` = 新帖），见 `own-sub-queue.ts` | 不另起轮询；没人看视图时一小时补读一页 |
 *
 * 五条纪律：
 *
 * 1. **只读**：只调适配器的 `feed` / `readAccess`（全是 GET）。不回复、不加反应、不判类、不出卡——
 *    人在「群里的帖子」里看了，要回就点「回复」出卡（WP255）。
 * 2. **同一条只记一次**：线程 id 拿平台消息 id 拼（`ct_discord_<消息id>`），已经记过的原样不动（可能已经回过了）。
 * 3. **记上次读到的位置**：每读完一页就把那一页最大的消息 id 存下（`ingest_state` 表），下一轮从它往后读；
 *    读到一半断了（429 / 5xx / 进程重启），下一轮从断的地方接着读，不漏、不重。
 * 4. **限速**：一轮每个频道最多 5 页（每页 100 条）；被平台说太快（429）就停下这一轮所有频道（同一个机器人令牌），
 *    隔两个周期再读。第一次读只取眼前这一页里 7 天内的，不往回翻历史。
 * 5. **缺权限照实说缺哪个**：第一次读、隔一天、或读不动（403）时查一次机器人在这个频道上的权限；缺了就停在
 *    `missing_permissions`，把缺的那几样摆在视图上（补上之后下一轮自己就能读）。
 *
 * 正文是外部文本：原样进线程表，进事件日志的只有渠道、账号 id 与条数。
 */
import type { SocialActor, SocialIngestAccountView, SocialIngestView } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  Clock,
  CommunityThread,
  SocialAccount,
  SocialChannel,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  compareSnowflake,
  readGapMessage,
  type SocialChannelAdapter,
  splitTarget,
} from '@agentsws/social-core'
import type { SocialIngestRow, SocialStore } from './social.js'

export const DISCORD_INGEST_DEFAULT_MINUTES = 15
export const DISCORD_INGEST_MIN_MINUTES = 5
export const DISCORD_INGEST_MAX_MINUTES = 24 * 60
/** 一轮每个频道最多读几页（每页 100 条）。 */
export const DISCORD_INGEST_MAX_PAGES = 5
const PAGE = 100
const FIRST_PAGE = 50
/** 第一次读只记这么近的（不把几个月前的老消息当「新帖」堆进来）。 */
const FIRST_READ_WINDOW_MS = 7 * 86_400_000
/** 权限一天查一次。 */
const ACCESS_RECHECK_MS = 86_400_000

/** 会自动进帖的渠道。 */
const AUTO_CHANNELS: readonly SocialChannel[] = ['discord', 'reddit']

export interface SocialIngestOptions {
  workspace_id: WorkspaceId
  store: SocialStore
  clock: Clock
  adapter(channel: SocialChannel): SocialChannelAdapter | undefined
  /** 这条渠道连上了没有（Reddit：接口或官方号浏览器有一条通）。 */
  connected(channel: SocialChannel): boolean
  emit(type: string, actor: string, payload: Record<string, unknown>): void
  /**
   * 这条渠道这会儿是不是被平台拦着（Reddit 官方号浏览器弹了验证码 / 被限流）——拦着时那条路暂时不通，
   * 但不是「没连上」，视图上要说清是被拦了。回那句人话；没被拦回 `undefined`。
   */
  blocked?(channel: SocialChannel): string | undefined
  /** Reddit 自家版那一半（WP249 的队列）。不给 = 这台没装配自家版待处理。 */
  ownSub?: { backgroundRead(): Promise<{ read: number; ingested: number }> }
}

export interface SocialIngestSweep {
  /** 这一轮读了几个频道 / 版。 */
  read: number
  /** 新记进来几条。 */
  ingested: number
  /** 没读成的（哪个号、为什么）。 */
  skipped: { account_id: string; reason: string }[]
}

export interface SocialIngest {
  /** 定时那一拍（社媒每 5 分钟那一条）：到点的频道读一轮，Reddit 自家版按需补读。 */
  sweep(): Promise<SocialIngestSweep>
  view(actor: SocialActor, channel: SocialChannel): SocialIngestView
  setInterval(
    actor: SocialActor,
    input: { channel: SocialChannel; every_minutes: number },
  ): SocialIngestView
}

const settingsId = (channel: SocialChannel): string => `settings:${channel}`

export function createSocialIngest(options: SocialIngestOptions): SocialIngest {
  const { store, clock } = options

  const everyMinutes = (): number =>
    store.ingestState(settingsId('discord'))?.every_minutes ?? DISCORD_INGEST_DEFAULT_MINUTES

  const later = (ms: number): string => new Date(Date.parse(clock.now()) + ms).toISOString()

  const save = (account: SocialAccount, patch: Partial<SocialIngestRow>): SocialIngestRow => {
    const row: SocialIngestRow = {
      ...store.ingestState(account.id),
      ...patch,
      id: account.id,
      channel: account.channel,
      account_id: account.id,
    }
    store.saveIngestState(row)
    return row
  }

  /** 这个号已经记过的消息 id（含经接口送进来、id 不是我们拼的那些）。 */
  const knownIds = (account: SocialAccount): Set<string> =>
    new Set(store.threads({ account_id: account.id }).map((t) => t.external_id))

  /** 查一次权限：缺了就停在 `missing_permissions`。回 `true` = 齐了可以读。 */
  const checkAccess = async (
    adapter: SocialChannelAdapter,
    account: SocialAccount,
    out: SocialIngestSweep,
  ): Promise<boolean> => {
    if (adapter.readAccess === undefined) return true
    const res = await adapter.readAccess(account.external_id)
    if (!res.ok) {
      // 查不了（网络等）不当成缺权限：照常往下读，读不动再说
      if (res.reason !== 'rate_limited') return true
      // 被限速：这个频道隔两个周期再来（调用方据此停下这一轮）
      save(account, {
        state: 'limited',
        message: res.message,
        last_read_at: clock.now(),
        next_read_at: later(everyMinutes() * 60_000 * 2),
      })
      out.skipped.push({ account_id: account.id, reason: res.message })
      return false
    }
    if (res.data.missing.length === 0) {
      save(account, { access_checked_at: clock.now(), missing: [] })
      return true
    }
    const message = readGapMessage('Discord', res.data.missing)
    save(account, {
      access_checked_at: clock.now(),
      state: 'missing_permissions',
      missing: res.data.missing,
      message,
      last_read_at: clock.now(),
      next_read_at: later(everyMinutes() * 60_000),
    })
    out.skipped.push({ account_id: account.id, reason: message })
    return false
  }

  /** 一个 Discord 频道读一轮。回 `'stop'` = 被限速了，这一轮别的频道也别读了。 */
  const readDiscord = async (
    adapter: SocialChannelAdapter,
    account: SocialAccount,
    out: SocialIngestSweep,
  ): Promise<'ok' | 'stop'> => {
    const interval = everyMinutes() * 60_000
    const row = store.ingestState(account.id)
    if (splitTarget(account.external_id).channel === undefined) {
      if (row?.state !== 'needs_channel')
        save(account, {
          state: 'needs_channel',
          message: '这个群只登记了服务器，没说读哪个频道：在「群里的帖子」里粘贴频道链接重新登记。',
        })
      return 'ok'
    }
    const nowMs = Date.parse(clock.now())
    if (row?.next_read_at !== undefined && Date.parse(row.next_read_at) > nowMs) return 'ok'
    const accessDue =
      row?.access_checked_at === undefined ||
      row.state === 'missing_permissions' ||
      nowMs - Date.parse(row.access_checked_at) >= ACCESS_RECHECK_MS
    if (accessDue && !(await checkAccess(adapter, account, out)))
      return store.ingestState(account.id)?.state === 'limited' ? 'stop' : 'ok'

    out.read += 1
    const known = knownIds(account)
    let cursor = row?.cursor
    let created = 0
    /** 这一轮怎么收的尾：读完了 / 被限速 / 没读成 / 查出来缺权限（那一笔 `checkAccess` 已经记了）。 */
    let ending:
      | { kind: 'done' }
      | { kind: 'limited' | 'failed'; message: string }
      | {
          kind: 'access'
        } = { kind: 'done' }
    const first = cursor === undefined
    for (let page = 0; page < (first ? 1 : DISCORD_INGEST_MAX_PAGES); page += 1) {
      const res = await adapter.feed?.({
        account_external_id: account.external_id,
        ...(cursor === undefined ? {} : { after: cursor }),
        limit: first ? FIRST_PAGE : PAGE,
      })
      if (res === undefined) break
      if (!res.ok) {
        // 已读的那几页留着（位置已经存了），下一轮从断的地方接着读
        if (res.reason === 'rate_limited') ending = { kind: 'limited', message: res.message }
        else if (res.status === 403 && !(await checkAccess(adapter, account, out)))
          ending = { kind: 'access' }
        else ending = { kind: 'failed', message: res.message }
        break
      }
      for (const item of res.data.items) {
        if (known.has(item.external_id)) continue
        if (first && nowMs - Date.parse(item.created_at) > FIRST_READ_WINDOW_MS) continue
        const thread: CommunityThread = {
          id: `ct_discord_${item.external_id}`,
          account_id: account.id,
          channel: 'discord',
          external_id: item.external_id,
          surface: item.surface,
          author_external_id: item.author_external_id,
          author_handle: item.author_handle,
          text: item.text,
          created_at: item.created_at,
          status: 'open',
        }
        store.saveThread(thread)
        known.add(item.external_id)
        created += 1
      }
      const last = res.data.last_id
      if (last !== undefined && (cursor === undefined || compareSnowflake(last, cursor) > 0))
        cursor = last
      // 每页存一次：读到一半断了，下一轮从这里接着读
      if (cursor !== undefined) save(account, { cursor })
      if (res.data.fetched < (first ? FIRST_PAGE : PAGE)) break
    }

    const prev = store.ingestState(account.id)
    const total = (prev?.ingested_total ?? 0) + created
    if (ending.kind === 'access') save(account, { ingested_total: total })
    else if (ending.kind === 'done') {
      // 读成了：上次的失败原话、缺的权限都不留
      const {
        message: _m,
        missing: _x,
        ...keep
      } = prev ?? {
        id: account.id,
        channel: account.channel,
      }
      store.saveIngestState({
        ...keep,
        id: account.id,
        channel: account.channel,
        account_id: account.id,
        state: 'ok',
        last_read_at: clock.now(),
        next_read_at: later(interval),
        ingested_total: total,
      })
    } else {
      save(account, {
        state: ending.kind,
        message: ending.message,
        last_read_at: clock.now(),
        // 被限速：隔两个周期再读；别的失败：下个周期再试
        next_read_at: later(ending.kind === 'limited' ? interval * 2 : interval),
        ingested_total: total,
      })
      out.skipped.push({ account_id: account.id, reason: ending.message })
    }
    out.ingested += created
    if (created > 0)
      options.emit('social.threads_ingested', 'system', {
        channel: 'discord',
        account_id: account.id,
        count: created,
      })
    return ending.kind === 'limited' ? 'stop' : 'ok'
  }

  const accountView = (account: SocialAccount, connected: boolean): SocialIngestAccountView => {
    const row = store.ingestState(account.id)
    const base = { account_id: account.id, name: account.display_name }
    if (!connected) {
      const blocked = options.blocked?.(account.channel)
      return blocked === undefined
        ? { ...base, state: 'not_connected' }
        : { ...base, state: 'limited', message: blocked }
    }
    if (account.channel === 'discord' && splitTarget(account.external_id).channel === undefined)
      return {
        ...base,
        state: 'needs_channel',
        message: row?.message ?? '只登记了服务器，没说读哪个频道。',
      }
    const times = {
      ...(row?.last_read_at === undefined ? {} : { last_read_at: row.last_read_at }),
      ...(row?.next_read_at === undefined ? {} : { next_read_at: row.next_read_at }),
    }
    if (row?.state === undefined || row.last_read_at === undefined)
      return { ...base, state: 'waiting', ...times }
    return {
      ...base,
      state: row.state === 'needs_channel' ? 'ok' : row.state,
      ...(row.state === 'ok' || row.message === undefined ? {} : { message: row.message }),
      ...(row.state === 'missing_permissions' && row.missing !== undefined
        ? { missing: row.missing }
        : {}),
      ...times,
    }
  }

  const view = (channel: SocialChannel): SocialIngestView => {
    const auto = AUTO_CHANNELS.includes(channel)
    const connected = options.connected(channel)
    const accounts = store
      .accounts({ channel })
      // Reddit 只有自家版会自动进帖（我们是版主才有新帖队列可读）
      .filter((a) => channel !== 'reddit' || a.own_subreddit === true)
    return {
      channel,
      auto,
      connected,
      ...(channel === 'discord' ? { every_minutes: everyMinutes() } : {}),
      accounts: auto ? accounts.map((a) => accountView(a, connected)) : [],
    }
  }

  return {
    async sweep() {
      const out: SocialIngestSweep = { read: 0, ingested: 0, skipped: [] }
      const discord = options.adapter('discord')
      if (discord?.feed !== undefined && options.connected('discord'))
        for (const account of store.accounts({ channel: 'discord' }))
          if ((await readDiscord(discord, account, out)) === 'stop') break
      if (options.ownSub !== undefined) {
        const r = await options.ownSub.backgroundRead().catch(() => ({ read: 0, ingested: 0 }))
        out.read += r.read
        out.ingested += r.ingested
      }
      return out
    },

    view: (_actor, channel) => view(channel),

    setInterval(actor, input) {
      if (input.channel !== 'discord')
        throw new ApiError('invalid_input', '现在只有 Discord 能调读取频率。')
      const minutes = Math.round(input.every_minutes)
      if (minutes < DISCORD_INGEST_MIN_MINUTES || minutes > DISCORD_INGEST_MAX_MINUTES)
        throw new ApiError('invalid_input', '读取频率要在 5 分钟到 24 小时之间。')
      store.saveIngestState({
        id: settingsId('discord'),
        channel: 'discord',
        every_minutes: minutes,
      })
      // 改了频率：已经排好的下一次按新频率重排（改短了不用干等旧的那一次）
      const nextAt = later(minutes * 60_000)
      for (const account of store.accounts({ channel: 'discord' })) {
        const row = store.ingestState(account.id)
        if (row?.next_read_at !== undefined && Date.parse(row.next_read_at) > Date.parse(nextAt))
          store.saveIngestState({ ...row, next_read_at: nextAt })
      }
      options.emit('social.ingest_interval_set', actor.person_id, {
        channel: 'discord',
        every_minutes: minutes,
      })
      return view('discord')
    },
  }
}
