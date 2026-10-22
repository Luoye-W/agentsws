/**
 * 一行右边那个时间（照 Claude：「刚刚 / 5 分钟 / 3 小时 / 2 天」，再早写月日）。
 * 搜索弹窗与看板「对话」卡共用（WP456-T3 从 `command-palette.tsx` 挪出来）。
 */
export function shortAgo(
  iso: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  lang: 'zh' | 'en',
  now: number = Date.now(),
): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const min = Math.max(0, Math.floor((now - at) / 60_000))
  if (min < 1) return t('ago.now')
  if (min < 60) return t('ago.m', { n: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('ago.h', { n: h })
  const d = Math.floor(h / 24)
  if (d < 7) return t('ago.d', { n: d })
  return new Date(at).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
  })
}
