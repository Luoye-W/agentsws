/**
 * WP439（docs/108 §5.7 ①，决策 336）：**回信建议按来信语言写**。
 *
 * 判语言用仓里现成的那一个（`support-core` 的 `detectLanguage`，客服起草也用它），外面多两步：
 *
 * 1. 只看对方**这一封**：引用的上一封（`>` 开头的行、「On … wrote:」之后）和链接 / 邮箱地址不算；
 * 2. **判不出就说判不出**（几乎没有字的信、只有链接的信）——那边宁可回 `en`，这里要退回品牌默认语言，
 *    再不行中文（{@link replyLanguage}）。中英夹杂时汉字多就按中文。
 */
import { detectLanguage } from '@agentsws/support-core'

/** 这封信是用什么语言写的（ISO 639-1 小写）；判不出回 `undefined`。 */
export function replyLanguageOf(...parts: (string | undefined)[]): string | undefined {
  const joined = parts.filter((p): p is string => typeof p === 'string').join('\n')
  const own =
    joined.split(/\n(?:On .{0,200}wrote:|-{2,}\s*Original Message\s*-{2,}|在 .{0,80}写道：)/i)[0] ??
    ''
  const text = own
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .replace(/https?:\/\/\S+|\S+@\S+/g, ' ')
  if (/[぀-ヿ]/.test(text)) return 'ja'
  const han = (text.match(/[一-龥]/g) ?? []).length
  const latinWords = (text.match(/[A-Za-zÀ-ÿ]{2,}/g) ?? []).length
  // 中英夹杂：汉字够多就按中文（「订单 #1234 的 tracking number 还没更新」是中文信）
  if (han >= 2 && han >= latinWords) return 'zh'
  if (latinWords < 2) return han > 0 ? 'zh' : undefined
  // 英文信末尾署个中文名不算中文信：只拿拉丁字母那部分去判
  return detectLanguage(text.replace(/[一-龥]/g, ' '))
}

/** 来信语言 → 品牌默认语言 → 中文。 */
export function replyLanguage(text: string, brandDefault?: string | undefined): string {
  const fallback = brandDefault?.trim().toLowerCase()
  return replyLanguageOf(text) ?? (fallback === undefined || fallback === '' ? 'zh' : fallback)
}
