/**
 * WP257（决策 156）：Telegram 群「群里的帖子」自动进帖——已连上的机器人低频读新消息（只读，不回复）。
 *
 * 与 Discord 同一套纪律（`social-ingest.ts` 文件头五条），不同的只有一处：**Telegram 一个机器人只有一条收件流**
 * （`getUpdates`），不分群。所以：
 *
 * 1. **按机器人续读**：读到哪儿记在 `settings:telegram_group` 那一行（`cursor` = 下一次的 `offset`），
 *    每读完一页存一次；断了（429 / 5xx / 重启）下一轮从断的地方接着读。Telegram 读走即确认，同一条不会给第二遍；
 *    万一存线程与存位置之间断了，下一轮那几条按消息 id 去重，不重记。
 * 2. **再按群分**：这一页里是品牌登记过的群（数字 id，或公开群的 @用户名）的，记成那个群的线程
 *    （`ct_telegram_<群id>_<消息id>`）；没登记的群、私聊不记（读走了就过去了）。
 * 3. **缺什么照实说**：隐私模式开着又不是管理员（只看得到 @它的话）、机器人不在群里、设了 webhook（读不了），
 *    按群各说各的；设了 webhook 这一轮就不读（读也是 409）。隐私模式开着时 @它的那几条照样记下。
 * 4. **一个群都没登记就不读**：读走即确认，没人登记时不该把机器人的消息白白读掉。
 */
import type { CommunityThread, SocialAccount } from '@agentsws/contracts'
import type { SocialChannelAdapter } from '@agentsws/social-core'
import type { SocialIngestRow, SocialStore } from './social.js'
import type { SocialIngestSweep } from './social-ingest.js'

/** 一轮最多读几页（每页 100 条）。 */
export const TELEGRAM_INGEST_MAX_PAGES = 5
const PAGE = 100
/** 权限一天查一次（同 Discord）。 */
const ACCESS_RECHECK_MS = 86_400_000
/** 第一次读只记这么近的（Telegram 本来只留 24 小时，这里与 Discord 同一个窗口）。 */
const FIRST_READ_WINDOW_MS = 7 * 86_400_000

export const TELEGRAM_SETTINGS_ID = 'settings:telegram_group'

export interface TelegramRoundKit {
  store: SocialStore
  clock: { now(): string }
  adapter: SocialChannelAdapter
  out: SocialIngestSweep
  /** 多久读一次（毫秒）。 */
  interval: number
  later(ms: number): string
  save(account: SocialAccount, patch: Partial<SocialIngestRow>): SocialIngestRow
  checkAccess(
    adapter: SocialChannelAdapter,
    account: SocialAccount,
    out: SocialIngestSweep,
  ): Promise<boolean>
  fillName(adapter: SocialChannelAdapter, account: SocialAccount): Promise<SocialAccount>
  saveTagged(thread: CommunityThread, mentions_us: boolean | undefined): void
  emit(type: string, actor: string, payload: Record<string, unknown>): void
}

const threadId = (chat: string, message: string): string => `ct_telegram_${chat}_${message}`

/** 读一轮（到点了才读）。 */
export async function readTelegramRound(kit: TelegramRoundKit): Promise<void> {
  const { store, clock, adapter, out } = kit
  if (adapter.updates === undefined) return
  const registered = store.accounts({ channel: 'telegram_group' })
  if (registered.length === 0) return
  const nowMs = Date.parse(clock.now())
  const settings = store.ingestState(TELEGRAM_SETTINGS_ID)
  if (settings?.next_read_at !== undefined && Date.parse(settings.next_read_at) > nowMs) return
  const saveSettings = (patch: Partial<SocialIngestRow>): void => {
    store.saveIngestState({
      ...store.ingestState(TELEGRAM_SETTINGS_ID),
      ...patch,
      id: TELEGRAM_SETTINGS_ID,
      channel: 'telegram_group',
    })
  }

  // ① 名字与权限：每个群各查各的（第一次、隔一天、上次缺东西时）
  const accounts: SocialAccount[] = []
  for (const r of registered) {
    const account = await kit.fillName(adapter, r)
    accounts.push(account)
    const row = store.ingestState(account.id)
    const due =
      row?.access_checked_at === undefined ||
      row.state === 'missing_permissions' ||
      nowMs - Date.parse(row.access_checked_at) >= ACCESS_RECHECK_MS
    if (!due) continue
    await kit.checkAccess(adapter, account, out)
    if (store.ingestState(account.id)?.state === 'limited') {
      // 被限速：整个机器人隔两个周期再读
      saveSettings({ last_read_at: clock.now(), next_read_at: kit.later(kit.interval * 2) })
      return
    }
  }
  // 设了 webhook：getUpdates 一定是 409，这一轮不读
  if (accounts.some((a) => store.ingestState(a.id)?.missing?.includes('webhook_active') === true)) {
    saveSettings({ last_read_at: clock.now(), next_read_at: kit.later(kit.interval) })
    return
  }

  // ② 读收件流，按群分
  const byChat = new Map<string, SocialAccount>()
  for (const a of accounts) {
    byChat.set(a.external_id, a)
    if (a.external_id.startsWith('@')) byChat.set(a.external_id.toLowerCase(), a)
  }
  const known = new Map<string, Set<string>>(
    accounts.map((a) => [
      a.id,
      new Set(store.threads({ account_id: a.id }).map((t) => t.external_id)),
    ]),
  )
  const created = new Map<string, number>()
  let cursor = settings?.cursor
  const first = cursor === undefined
  let ending: { kind: 'done' } | { kind: 'limited' | 'failed'; message: string } = { kind: 'done' }
  out.read += 1
  for (let page = 0; page < TELEGRAM_INGEST_MAX_PAGES; page += 1) {
    const res = await adapter.updates({
      ...(cursor === undefined ? {} : { offset: cursor }),
      limit: PAGE,
    })
    if (!res.ok) {
      if (res.reason === 'rate_limited') ending = { kind: 'limited', message: res.message }
      else if (res.status === 409) {
        // 别处设了 webhook：查一遍，缺什么落到每个群那一行上
        for (const a of accounts) await kit.checkAccess(adapter, a, out)
        ending = {
          kind: 'failed',
          message:
            'Telegram 机器人设了 webhook（别的工具在收它的消息），Agents 工坊读不到群消息：在那个工具里停掉 webhook，或给工坊单独建一个机器人。',
        }
      } else ending = { kind: 'failed', message: res.message }
      break
    }
    for (const item of res.data.items) {
      const account =
        byChat.get(item.chat_id) ??
        (item.chat_username === undefined
          ? undefined
          : byChat.get(`@${item.chat_username}`.toLowerCase()))
      // 没登记的群：读走了就过去了（文件头第 2 条）
      if (account === undefined) continue
      const seen = known.get(account.id) ?? new Set<string>()
      const c = item.comment
      if (seen.has(c.external_id)) continue
      if (first && nowMs - Date.parse(c.created_at) > FIRST_READ_WINDOW_MS) continue
      kit.saveTagged(
        {
          id: threadId(item.chat_id, c.external_id),
          account_id: account.id,
          channel: 'telegram_group',
          external_id: c.external_id,
          surface: c.surface,
          author_external_id: c.author_external_id,
          author_handle: c.author_handle,
          text: c.text,
          created_at: c.created_at,
          status: 'open',
        },
        c.mentions_us,
      )
      seen.add(c.external_id)
      known.set(account.id, seen)
      created.set(account.id, (created.get(account.id) ?? 0) + 1)
    }
    if (res.data.next_offset !== undefined) {
      cursor = res.data.next_offset
      // 每页存一次：读到一半断了，下一轮从这里接着读
      saveSettings({ cursor })
    }
    if (res.data.fetched < PAGE) break
  }

  // ③ 收尾：机器人那一行排下一次；每个群那一行记状态与条数
  const next = kit.later(ending.kind === 'limited' ? kit.interval * 2 : kit.interval)
  saveSettings({ last_read_at: clock.now(), next_read_at: next })
  for (const account of accounts) {
    const prev = store.ingestState(account.id)
    const n = created.get(account.id) ?? 0
    const total = (prev?.ingested_total ?? 0) + n
    const times = { last_read_at: clock.now(), next_read_at: next, ingested_total: total }
    if (prev?.state === 'missing_permissions') kit.save(account, times)
    else if (ending.kind === 'done') {
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
        ...times,
      })
    } else {
      kit.save(account, { state: ending.kind, message: ending.message, ...times })
      out.skipped.push({ account_id: account.id, reason: ending.message })
    }
    out.ingested += n
    if (n > 0)
      kit.emit('social.threads_ingested', 'system', {
        channel: 'telegram_group',
        account_id: account.id,
        count: n,
      })
  }
}
