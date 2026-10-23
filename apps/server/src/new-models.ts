/**
 * WP479（决策 1625）：已连接的订阅 / 账号 / API key 有新模型了 → 铃铛里一条（同一来源同一批合成一条）。
 *
 * 照 WP294 退役模型那条现成的路走（`system_alert`，WP466 起在铃铛里）：不是卡、不要人拍板，只要人知道；
 * 点开到设置 → 模型，那个来源的清单自己展开、新模型标「新」，人自己勾。**不自动勾**。
 * 人在设置里看过就退场（`markModelsSeen`）。工坊积分那一组不走这里（我们自己发版时说）。
 */
import type { ModelEnableNotice } from '@agentsws/api'
import type { DeckCard } from '@agentsws/deck'
import { actionsFor, labelsFor, layoutFor } from '@agentsws/deck'

/** 点开去哪：设置 → 模型，`#models-<来源>` 让那一个来源的清单展开并高亮。 */
export function newModelsOpenPath(provider_id: string): string {
  return `/settings/models#models-${encodeURIComponent(provider_id)}`
}

/** 铃铛那一条的标题：「ChatGPT 订阅有新模型：GPT-6.1 Sol、GPT-6.1 Luna」（多于三个说「等 N 个」）。 */
export function newModelsTitle(notice: Pick<ModelEnableNotice, 'label' | 'models'>): string {
  const names = notice.models.map((m) => m.name ?? m.id)
  const shown = names.slice(0, 3).join('、')
  const more = names.length > 3 ? ` 等 ${names.length} 个` : ''
  return `${notice.label}有新模型：${shown}${more}`
}

export function newModelNoticeCard(input: {
  notice: ModelEnableNotice
  position_id: string
}): DeckCard {
  const { notice } = input
  // 同一来源同一批 id 稳定（铃铛按 id 去重 / 记已读）；再来一批（`at` 变了）算新的一条
  const id = `new_models_${notice.provider_id}_${notice.at}`.replace(/[^a-zA-Z0-9]+/g, '_')
  const title = newModelsTitle(notice)
  const summary = '要用就去设置里勾上；不勾不会出现在模型选择里。'
  const actions = actionsFor('system_alert', 'pending')
  return {
    id,
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
        kind: 'new_models',
        open_path: newModelsOpenPath(notice.provider_id),
        provider_id: notice.provider_id,
        models: notice.models.map((m) => m.id),
      },
      precheck: {},
      citations: [],
      links: { children: [] },
      created_at: notice.at,
      updated_at: notice.at,
      proposer: { kind: 'system', id: 'new_models' },
      enrichment: { dropped_refs: 0 },
    },
    dedupe_key: `new_models|${id}`,
    snooze_count: 0,
    merge_count: 1,
    version: 1,
  }
}
