/**
 * WP411（客户真机 10-18 #10 #11）：模拟世界里的 **Reddit 巡查质量闸**——一批读回来的条目
 * 过和服务进程同一份纯函数（`@agentsws/social-core` 的整词匹配、按全名去重、外部帖闸）：
 * 外部关键词没整词出现的丢掉；收件箱 / 自家版块同一条只留一份；外部帖只有真提到我们（不在个人主页、
 * 不在竞品版）才交给起草。巡查自己零写：只记一条 `simulation.reddit_watch_filtered`。
 */
import { dedupeByFullname, externalReplyGate, keywordNoise } from '@agentsws/social-core'
import type { ScenarioRedditWatchBatch } from './scenario/types.js'
import type { World } from './world.js'

export function runRedditWatchBatch(world: World, batch: ScenarioRedditWatchBatch): void {
  const ctx = {
    brand_names: batch.brand_names,
    models: batch.models ?? [],
    competitors: batch.competitors ?? [],
  }
  let filtered = 0
  const passed = batch.items.filter((it) => {
    if (it.source !== 'external' || it.keyword === undefined) return true
    const keep = keywordNoise(it, it.keyword, ctx).keep
    if (!keep) filtered += 1
    return keep
  })
  const { kept, dupes } = dedupeByFullname(passed)
  const draftable = kept
    .filter((it) => it.reply === true)
    .filter((it) => it.source !== 'external' || externalReplyGate(it, ctx).ok)
    .map((it) => it.fullname)
  world.appendEvent('simulation.reddit_watch_filtered', {
    kept: kept.map((it) => it.fullname),
    filtered,
    dupes: dupes.length,
    draftable,
  })
}
