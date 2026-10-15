/**
 * WP328：一周汇总（默认周日起）。数字直接从库里数，不经模型（docs/29）。
 *
 * - 自家版块：窗口内新帖 / 新评论数（按 Reddit 上的发帖时间；含我们自己发的，另记一份）；
 * - VOC / UGC：自家版块与收件箱里**有效的**（AI 判断里有那一格才算）；
 * - 外部社区：按话题归组，评估判断取组里最要紧的那一档（有一条需跟进整组就是需跟进）；
 * - 哪几块这周没读成照实列出（不当成 0）。
 */
import type {
  Iso8601,
  RedditWatchDigest,
  RedditWatchEntry,
  RedditWatchPart,
  RedditWatchSettings,
  RedditWatchTopicGroup,
  RedditWatchVerdict,
  WorkspaceId,
} from '@agentsws/contracts'
import type { RedditWatchStore } from './store.js'

const LIST_MAX = 5000
const RANK: Record<RedditWatchVerdict, number> = { follow_up: 0, no_action: 1, low_relevance: 2 }

export function buildDigest(input: {
  store: RedditWatchStore
  workspace_id: WorkspaceId
  settings: RedditWatchSettings
  since: Iso8601
  until: Iso8601
}): RedditWatchDigest {
  const { store, since, until } = input
  const ws = input.workspace_id
  const q = { since, until, limit: LIST_MAX }
  const own = store.list(ws, { ...q, source: 'own_sub' })
  const inbox = store.list(ws, { ...q, source: 'inbox' })
  const external = store.list(ws, { ...q, source: 'external' })
  const count = (xs: RedditWatchEntry[], kind: RedditWatchEntry['kind']): number =>
    xs.filter((x) => x.kind === kind).length
  const ownOurs = own.filter((x) => x.ours === true)
  const voices = [...own, ...inbox].filter((x) => x.ours !== true && x.deleted !== true)

  const groups = new Map<string, RedditWatchTopicGroup>()
  for (const it of external) {
    if (it.deleted === true) continue
    const topic =
      it.judgement?.topic ??
      (it.keyword !== undefined
        ? `关键词：${it.keyword}`
        : it.subreddit !== undefined
          ? `r/${it.subreddit}`
          : '其他')
    const verdict = it.judgement?.verdict ?? 'no_action'
    const g = groups.get(topic) ?? { topic, verdict, posts: 0, comments: 0, items: [] }
    if (RANK[verdict] < RANK[g.verdict]) g.verdict = verdict
    if (it.kind === 'comment') g.comments += 1
    else g.posts += 1
    g.items.push(it)
    groups.set(topic, g)
  }
  const ext = [...groups.values()].sort(
    (a, b) => RANK[a.verdict] - RANK[b.verdict] || b.items.length - a.items.length,
  )

  const runs = store.runs(ws, { since, limit: 1000 }).filter((r) => r.started_at <= until)
  const latest = new Map<RedditWatchPart, { status: string; message?: string }>()
  // 新的在前：每块取最近一次真读过（不是 skipped）的结局
  for (const r of runs)
    for (const p of r.parts)
      if (p.status !== 'skipped' && !latest.has(p.part))
        latest.set(p.part, {
          status: p.status,
          ...(p.message === undefined ? {} : { message: p.message }),
        })
  const gaps: RedditWatchDigest['gaps'] = []
  for (const [part, v] of latest)
    if (v.status !== 'ok' && v.status !== 'waiting')
      gaps.push({ part, message: v.message ?? '这一块没读成' })
  const last = runs[0]
  return {
    workspace_id: ws,
    since,
    until,
    own_sub: {
      subreddits: [...input.settings.own_subreddits],
      posts: count(own, 'post'),
      comments: count(own, 'comment'),
      ours: { posts: count(ownOurs, 'post'), comments: count(ownOurs, 'comment') },
    },
    voc: voices.filter((x) => x.judgement?.voc !== undefined),
    ugc: voices.filter((x) => x.judgement?.ugc !== undefined),
    external: ext,
    inbox: {
      total: inbox.length,
      reply: inbox.filter((x) => x.judgement?.reply === true).length,
    },
    runs: runs.length,
    ...(last === undefined ? {} : { last_run_at: last.finished_at ?? last.started_at }),
    final_done: runs.some((r) => r.final && r.finished_at !== undefined),
    gaps,
  }
}
