import type { ModelFeature, ModelMeta } from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'

/**
 * WP473（docs/116 §6 D）：这一次模型调用记在用量页的哪一行。
 *
 * 调用方显式给了 `meta.feature` 就照它；没给按 `purpose` 与 `run_id` 的前缀认——这些前缀是各调用处
 * 一直在用的写法（客服聊天窗 `run_chat_`、邮件自动回 `run_email_auto_`……），认它们就不用把三十多处
 * 调用逐个改一遍。岗位运行的 id 是 `run_<随机串>`（运行时 `newId('run')`），后面没有第二个下划线。
 * 认不出的一律「其它」，不猜。
 */
const PREFIXES: readonly (readonly [string, ModelFeature])[] = [
  ['fchat_', 'assistant'],
  ['run_chat_', 'support_chat'],
  ['run_email_auto_', 'email_auto_reply'],
  ['run_seo_', 'seo'],
  ['run_geo_', 'seo'],
  ['run_b2b', 'b2b'],
  ['run_ads_', 'ads'],
  ['adcopy_', 'ads'],
  ['run_social_', 'social'],
  ['run_reddit_', 'social'],
  ['reddit_', 'social'],
  ['social_', 'social'],
]

/** 岗位运行（含事项对话、浏览器那一档）的 id：`run_` + 一段字母数字，没有别的下划线。 */
const POSITION_RUN = /^run_[a-z0-9]+$/i

export function featureOf(meta: Pick<ModelMeta, 'purpose' | 'run_id' | 'feature'>): ModelFeature {
  if (meta.feature !== undefined) return meta.feature
  if (meta.purpose === 'free_chat') return 'assistant'
  const id = String(meta.run_id ?? '')
  for (const [prefix, feature] of PREFIXES) if (id.startsWith(prefix)) return feature
  if (POSITION_RUN.test(id)) return 'position_run'
  return 'other'
}

/**
 * WP473（docs/116 §3 / brief 第 5 条）：发给 OpenAI 系（`prompt_cache_key`）与订阅（会话标识）的缓存分组键。
 *
 * 默认「工作区 + 职责」——同一职责的运行开头那大段（岗位说明、技能、工具）一样，分到一组才命中；
 * 调用方给了 `cache_scope`（如助理的段 id）就按它分。**只发哈希**：原文里即使混进了人名、邮箱，
 * 出门的也只是 `aw_` + 32 位十六进制（OpenAI 的键上限 64 个字符）。
 */
export function promptCacheKeyOf(
  meta: Pick<ModelMeta, 'workspace_id' | 'role_id' | 'cache_scope'> | undefined,
): string | undefined {
  if (meta === undefined) return undefined
  const scope =
    meta.cache_scope !== undefined && meta.cache_scope !== ''
      ? `scope:${meta.cache_scope}`
      : `role:${String(meta.role_id ?? '')}`
  return `aw_${sha256(`${String(meta.workspace_id ?? '')}\u0000${scope}`).slice(0, 32)}`
}
