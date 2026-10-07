/**
 * WP243：Rollout 那句「说说你要做什么」的一份**像真模型会回的**紧凑答案（新格式），
 * 以及同样内容用老格式写出来的样子——好比较输出长度。
 *
 * 21 条职责（10-06 真机那一次推了 5 岗 21 职责），原话都是 {@link ROLLOUT_TEXT} 里真有的字。
 */
import { ROLLOUT_TEXT } from './wp242-fixtures.js'

export { ROLLOUT_TEXT }

type Row = [id: string, reason: string, quote: string]

const ROWS: Row[] = [
  ['site.shopify-build', '独立站刚建好要搭骨架', 'Shopify 独立站'],
  ['site.shopify-theme', '要改主题', '改主题'],
  ['site.shopify-email', '新站要配自动邮件', 'Shopify 独立站'],
  ['site.shopify-apps', '新站要装插件', 'Shopify 独立站'],
  ['dtc.store', '独立站日常要人管', '独立站'],
  ['dtc.content', '独立站要写内容', '独立站'],
  ['social.tiktok', '要做社媒', '要做社媒'],
  ['social.youtube', '要做社媒', '要做社媒'],
  ['social.facebook', '要做社媒', '要做社媒'],
  ['social.instagram', '要做社媒', '要做社媒'],
  ['design.social', '社媒要出图', '要做社媒'],
  ['kol.youtube', '找红人合作', '找红人和达人合作'],
  ['kol.instagram', '找红人合作', '找红人和达人合作'],
  ['kol.tiktok', '找达人合作', '找红人和达人合作'],
  ['ads.meta', '跑广告投放', '跑广告投放'],
  ['ads.google', '跑广告投放', '跑广告投放'],
  ['design.ads', '广告要出素材', '跑广告投放'],
  ['dtc.support', '客服管售前售后', '客服管售前售后'],
  ['dtc.live-chat', '售前要在线答', '售前'],
  ['dtc.community-support', '社媒评论私信要回', '要做社媒'],
  ['design.dtc', '独立站要出图', '改主题'],
]

const POSITIONS: [string, string[]][] = [
  ['建站', ['site.shopify-build', 'site.shopify-theme', 'site.shopify-email', 'site.shopify-apps']],
  ['网站运营', ['dtc.store', 'dtc.content', 'design.dtc']],
  ['社媒运营', ['social.tiktok', 'social.youtube', 'social.facebook', 'social.instagram']],
  ['红人营销', ['kol.youtube', 'kol.instagram', 'kol.tiktok']],
  ['投放', ['ads.meta', 'ads.google', 'design.ads', 'design.social']],
  ['客服', ['dtc.support', 'dtc.live-chat', 'dtc.community-support']],
]

/** 新格式（WP243 提示词要的那种）：`{"r":[[id,理由,原话]],"p":[[名字,[id…]]]}`，不换行。 */
export const ROLLOUT_COMPACT_ANSWER = JSON.stringify({ r: ROWS, p: POSITIONS })

/** 同样的内容，老格式（WP234 提示词要的那种，模型通常还会缩进换行——这里按缩进 2 算）。 */
export const ROLLOUT_OLD_ANSWER = JSON.stringify(
  {
    roles: ROWS.map(([role_id, reason, quote]) => ({ role_id, reason, quote })),
    positions: POSITIONS.map(([name, role_ids]) => ({ name, role_ids })),
  },
  null,
  2,
)

/**
 * DeepSeek 官方给的估算口径：1 个英文字符 ≈ 0.3 token，1 个中文字 ≈ 0.6 token。
 * 没有本机分词器，只拿它比新旧两种写法差多少（真数以真机 `model.usage.output_tokens` 为准）。
 */
export function estimateDeepSeekTokens(text: string): number {
  let n = 0
  for (const ch of text) n += /[㐀-鿿＀-￯　-〿]/.test(ch) ? 0.6 : 0.3
  return Math.ceil(n)
}
