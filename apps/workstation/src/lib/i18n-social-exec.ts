/**
 * WP254（决策 117）：版务卡（改动卡「批准执行 / 不做」）与回帖卡的词条（中英各一份）。
 * 单独一个文件、在 `i18n.ts` 的表里并进去（同 `i18n-own-sub.ts`）。
 */
export const SOCIAL_EXEC_ZH: Record<string, string> = {
  'verb.moderation.approve': '批准执行',
  'verb.moderation.reject': '不做',
  'category.moderation': '版务',
  'moderation.card.will_do': '将执行',
  'moderation.card.original': '原话',
  'moderation.card.reason': '依据',
  'moderation.card.rules': '违反的群规',
}

export const SOCIAL_EXEC_EN: Record<string, string> = {
  'verb.moderation.approve': 'Approve & run',
  'verb.moderation.reject': "Don't",
  'category.moderation': 'Moderation',
  'moderation.card.will_do': 'Will do',
  'moderation.card.original': 'Original',
  'moderation.card.reason': 'Why',
  'moderation.card.rules': 'Rules broken',
}
