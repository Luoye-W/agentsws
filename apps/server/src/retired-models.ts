/**
 * WP294（决策 375）：订阅模型退役了，存着的选择自动换成顶替它的那个，再留一条提醒。
 *
 * pi-ai 1.1.0 把 ChatGPT 订阅（`openai-codex`）目录里的 `gpt-5.4` / `gpt-5.4-mini` 删了。
 * 老用户存着这两个名字的地方有两处：`subscription.json` 里每人选的模型、`models.json` 里
 * 那一条订阅 provider 的 `model`。两处都在**启动读的时候**换（退役表在
 * `@agentsws/dsh-adapter/subscription-facts`），换完落盘，并记下「换了什么、什么时候」。
 *
 * 提醒照 WP169 店铺校正那条现成的路走（36 §2.2b「`system_alert` → 通知 + 告警块」）：
 * 不是卡——不要人拍板，只要人知道；想换别的去设置页的模型那一块。
 * 挂 {@link RETIRED_MODEL_NOTICE_DAYS} 天，或人自己改过模型就退场。
 */
import type { DeckCard } from '@agentsws/deck'
import { actionsFor, labelsFor, layoutFor } from '@agentsws/deck'

/** 提醒在首页告警区挂几天（没人动就自己退场；人改过模型当场退场）。 */
export const RETIRED_MODEL_NOTICE_DAYS = 7

/** 点开去哪：设置页里的模型那一块（与余额不足提示、顶栏同一个链接）。 */
export const MODELS_SETTINGS_PATH = '/settings?tab=models'

/** 一次自动换模型（落在 `subscription.json` / `models.json` 里，重启还在）。 */
export interface RetiredModelSwap {
  from: string
  to: string
  /** 什么时候换的（ISO8601）。 */
  at: string
}

/** 这一条还该不该提醒：没过期、而且现在存着的还是换上去的那个（人改过就不提了）。 */
export function retiredSwapLive(swap: RetiredModelSwap, current: string, now: string): boolean {
  if (current !== swap.to) return false
  const age = Date.parse(now) - Date.parse(swap.at)
  return age < RETIRED_MODEL_NOTICE_DAYS * 86_400_000
}

/** 提醒 → 首页告警区那一行（`system_alert`，点「去处理」到设置页的模型那一块）。 */
export function retiredModelNoticeCard(input: {
  /** 同一个人同一处同一次换模型，id 稳定（首页按 id 去重 / 记已读）。 */
  id: string
  swap: RetiredModelSwap
  position_id: string
}): DeckCard {
  const { swap } = input
  const title = `ChatGPT 订阅的 ${swap.from} 停用了，已换成 ${swap.to}`
  const summary = `官方不再提供 ${swap.from}。想换别的，去设置里的模型那一块。`
  const actions = actionsFor('system_alert', 'pending')
  return {
    id: input.id,
    kind: 'system_alert',
    layout: layoutFor('system_alert'),
    status: 'pending',
    priority_band: 'P3',
    priority: 'queue',
    risk_class: 'low',
    title,
    summary,
    content_variants: { zh_summary: summary },
    position_id: input.position_id,
    role_id: 'common.owner',
    channel: 'system',
    source: 'system',
    highlights: [],
    evidence_chips: [],
    entity_chips: [],
    available_actions: actions,
    action_labels: labelsFor('system_alert', actions),
    detail: {
      payload: {
        kind: 'retired_model_swap',
        open_path: MODELS_SETTINGS_PATH,
        from: swap.from,
        to: swap.to,
      },
      precheck: {},
      citations: [],
      links: { children: [] },
      created_at: swap.at,
      updated_at: swap.at,
      proposer: { kind: 'system', id: 'retired_model' },
      enrichment: { dropped_refs: 0 },
    },
    dedupe_key: `retired_model|${input.id}`,
    snooze_count: 0,
    merge_count: 1,
    version: 1,
  }
}
