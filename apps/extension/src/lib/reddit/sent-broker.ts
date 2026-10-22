/**
 * WP467：「人自己发出去的照样记」在 service worker 里那一半——把 {@link watchSentOnce} / {@link latestSent}
 * 接到本机服务（回写「已记录」）与浏览器（开着的原帖页、借会话只读）上。
 *
 * - 侧边栏每次刷新、每分钟那一拍、Reddit 标签页刚加载完，都看一遍（同一时刻只看一遍，几秒内不重复）；
 * - 还没批的卡被认出来 = 人已经亲手发了：在插件里批（`via: extension`）再记已发——和「打开这一条」是同一张卡、同一份记录；
 * - 侧边栏「我发了，帮我记一下」：贴链接 / 认最近一条，也走这里。
 */
import {
  type PanelSentInput,
  type PanelSnapshot,
  type PostedHit,
  type RedditFetched,
  redditPostIdOf,
} from '@agentsws/browser-action'
import { panelFill, panelSent, panelSnapshot } from '../local-client'
import type { KeyValueStore } from '../storage'
import { readSettings } from '../storage'
import { readRedditStatus } from './poller'
import {
  latestSent,
  type SentWatchDeps,
  type WatchTarget,
  watchSentOnce,
  watchTargets,
} from './sent-watch'

export interface SentBrokerDeps {
  store: KeyValueStore
  fetch?: typeof globalThis.fetch | undefined
  now(): number
  /** 浏览器那一侧（开着的新版 Reddit 标签页、在页面里认那一条）。 */
  page: Pick<SentWatchDeps, 'tabs' | 'find'>
  /** 借这个 Chrome 的 Reddit 会话只读一页（「认最近一条」）。 */
  read(url: string): Promise<RedditFetched>
}

/** 两遍之间至少隔多久。 */
export const WATCH_GAP_MS = 4_000

async function clientOf(deps: SentBrokerDeps) {
  const s = await readSettings(deps.store)
  if (s.token === undefined) return undefined
  return {
    port: s.port,
    token: s.token,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  }
}

/** 当前登录的号：插件巡查时读到的，没有就用工坊里设的品牌号。 */
async function meOf(deps: SentBrokerDeps, snap: PanelSnapshot | undefined) {
  const st = await readRedditStatus(deps.store)
  return st.user ?? snap?.progress.account
}

/**
 * 记一条：还没批的卡先在插件里批（人已经亲手发了），再回写「已记录」。回一句人话（没记上时）。
 */
export async function recordSent(
  deps: SentBrokerDeps,
  target: Pick<WatchTarget, 'job' | 'card'>,
  input: PanelSentInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const c = await clientOf(deps)
  if (c === undefined) return { ok: false, message: '还没配对。' }
  let job = target.job
  if (job === undefined && target.card !== undefined) {
    const got = await panelFill(c, target.card.id, { version: target.card.version })
    if (!got.ok) return { ok: false, message: got.message }
    if (!got.data.ok) return { ok: false, message: got.data.message }
    job = got.data.write?.job_id
  }
  if (job === undefined) return { ok: false, message: '找不到这一条，刷新一下再点。' }
  const sent = await panelSent(c, job, input)
  if (!sent.ok) return { ok: false, message: sent.message }
  if (!sent.data.ok) return { ok: false, message: sent.data.message }
  return { ok: true }
}

const inputOf = (how: PanelSentInput['how'], hit: PostedHit): PanelSentInput => ({
  how,
  ...(hit.permalink === undefined ? {} : { permalink: hit.permalink }),
  ...(hit.fullname === undefined ? {} : { fullname: hit.fullname }),
  ...(hit.text === undefined ? {} : { text: hit.text.slice(0, 10_000) }),
  ...(hit.author === undefined ? {} : { author: hit.author }),
})

export class SentWatcher {
  private running = false
  private lastAt = 0
  /** 已经记过的（键与那一条的编号）。 */
  readonly done = new Set<string>()

  constructor(private readonly deps: SentBrokerDeps) {}

  /** 看一遍（给了快照就用它；没给就去问一份新的）。回记上了几条。 */
  async tick(snap?: PanelSnapshot): Promise<number> {
    const now = this.deps.now()
    if (this.running || now - this.lastAt < WATCH_GAP_MS) return 0
    this.running = true
    this.lastAt = now
    try {
      let s = snap
      if (s === undefined) {
        const c = await clientOf(this.deps)
        if (c === undefined) return 0
        const got = await panelSnapshot(c)
        if (!got.ok) return 0
        s = got.data
      }
      if (!s.can_act) return 0
      const current = s
      return await watchSentOnce(
        watchTargets(current, now),
        {
          ...this.deps.page,
          me: () => meOf(this.deps, current),
          record: async (t, hit) => (await recordSent(this.deps, t, inputOf('seen', hit))).ok,
        },
        this.done,
      )
    } finally {
      this.running = false
    }
  }

  /**
   * 侧边栏「我发了，帮我记一下」：`link` = 贴的那一条的链接；`latest` = 认这个帖子里当前登录的号最新发的那一条。
   */
  async manual(
    ref: { job?: string; card?: { id: string; version: number } },
    how: 'link' | 'latest',
    link?: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const c = await clientOf(this.deps)
    if (c === undefined) return { ok: false, message: '还没配对。' }
    const got = await panelSnapshot(c)
    if (!got.ok) return { ok: false, message: got.message }
    const target = watchTargets(got.data, this.deps.now(), { manual: true }).find(
      (t) =>
        (ref.job !== undefined && t.job === ref.job) ||
        (ref.card !== undefined && t.card?.id === ref.card.id),
    )
    const w = got.data.writes.find((x) => x.job_id === ref.job)
    const post = target?.post ?? w?.target_post
    if (how === 'link') {
      const l = link?.trim() ?? ''
      if (l === '') return { ok: false, message: '先把那一条的链接贴进来。' }
      const id = redditPostIdOf(l)
      if (id === undefined)
        return { ok: false, message: '这不像 Reddit 评论的链接（要那一条评论的永久链接）。' }
      if (post !== undefined && id !== post)
        return { ok: false, message: '这条链接不是这个帖子里的，没记。' }
      return recordSent(this.deps, ref, { how: 'link', permalink: l })
    }
    if (target === undefined)
      return { ok: false, message: '这一条认不了最近一条（发新帖或没记下帖子）。贴链接吧。' }
    const found = await latestSent(target, {
      read: this.deps.read,
      me: await meOf(this.deps, got.data),
    })
    if (!found.ok) return found
    const out = await recordSent(this.deps, ref, inputOf('latest', found.hit))
    if (out.ok) this.done.add(target.key)
    return out
  }
}
