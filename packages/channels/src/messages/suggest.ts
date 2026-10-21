/**
 * WP113（63 §6）：**回复建议**。
 *
 * 四条纪律，每一条都能在类型上看见：
 *
 * 1. **只对 `needs_reply` 的信生成**，而且**打开那封信时才生成**
 *    （{@link ReplySuggester.suggest} 带缓存）。对全量来信预生成是最贵的错法：
 *    一只邮箱两千封信，九成没人会打开。
 * 2. **三条要有差别**（短 / 详 / 婉拒），不是同义改写。所以请求里把三种口吻
 *    写进 `kinds`，由宿主一次要三条——而不是让模型"再来一个"。
 * 3. **人改完自己点发送**。这个模块只产出文本，它碰不到 outbox。
 * 4. **非岗位信件永不自动发**——这里没有任何一条路通向"发送"。
 *
 * 模型在 {@link SuggestModel} 后面（包内不调模型，22）。语气与签名由宿主从
 * 个人层技能 / 记忆（54 的六层）取好塞进 `voice`；知识库命中由宿主塞进
 * `knowledge`，本模块只负责把出处原样带回 {@link ReplySuggestion.citations}。
 */

import type { ReplySuggestion, ReplySuggestionKind } from '@agentsws/contracts'

export const SUGGESTION_KINDS: readonly ReplySuggestionKind[] = ['short', 'detailed', 'decline']

/** 送进模型的那一份（**只有正文前 2000 字，没有附件**）。 */
export interface SuggestRequest {
  subject: string
  from: string
  /** 本封纯文本（宿主已裁到 2000 字）。 */
  body: string
  /** 这条会话里前几封的摘要（不含正文全文）。 */
  context: string[]
  /** 语气与签名（个人层技能 / 记忆）。 */
  voice?: string
  /** 知识库命中的那几条：`text` 进提示词，`source_id` / `title` 原样带回出处。 */
  knowledge: { source_id: string; title: string; text: string }[]
  kinds: readonly ReplySuggestionKind[]
  /**
   * 回信用什么语言写（ISO 639-1 小写：`zh` / `en` / `es`……）。WP439（决策 336）：**按来信语言**——
   * 宿主按来信正文判，判不出退回品牌默认语言，再不行中文。
   */
  lang: string
  /** WP439：三条建议的**标题**用什么语言（界面语言，和回信语言无关）。缺省中文。 */
  ui_lang?: 'zh' | 'en'
}

export interface SuggestModel {
  suggest(req: SuggestRequest): Promise<{ kind: ReplySuggestionKind; text: string }[]>
}

/** 缓存的一份（按消息 id）。 */
interface CacheEntry {
  at: number
  suggestions: ReplySuggestion[]
}

export interface ReplySuggesterOptions {
  model?: SuggestModel
  /** 缓存多久（默认 30 分钟）。同一封信反复开不该反复花钱。 */
  ttl_ms?: number
  now(): number
}

const TITLES: Record<ReplySuggestionKind, { zh: string; en: string }> = {
  short: { zh: '简短回一句', en: 'Short reply' },
  detailed: { zh: '详细说明', en: 'Detailed reply' },
  decline: { zh: '婉拒', en: 'Politely decline' },
}

export class ReplySuggester {
  private readonly opts: ReplySuggesterOptions
  private readonly cache = new Map<string, CacheEntry>()

  constructor(opts: ReplySuggesterOptions) {
    this.opts = opts
  }

  /**
   * 给这封信出 1–3 条建议。
   *
   * 没装模型 / 模型挂了 → 回**空数组**，不是抛。界面照实说"这台机器上还没接模型，
   * 回复建议出不来"，而写信框照常能用——人自己写信不该因为没接模型而做不了。
   */
  async suggest(message_id: string, req: SuggestRequest): Promise<ReplySuggestion[]> {
    const ttl = this.opts.ttl_ms ?? 1_800_000
    const now = this.opts.now()
    const hit = this.cache.get(message_id)
    if (hit !== undefined && now - hit.at < ttl) return hit.suggestions
    const model = this.opts.model
    if (model === undefined) return []
    let raw: { kind: ReplySuggestionKind; text: string }[]
    try {
      raw = await model.suggest(req)
    } catch {
      return []
    }
    const citations = req.knowledge.map((k) => ({ source_id: k.source_id, title: k.title }))
    const suggestions: ReplySuggestion[] = raw
      .filter((r) => r.text.trim() !== '')
      .slice(0, 3)
      .map((r, i) => ({
        id: `sug_${message_id}_${i}`,
        kind: r.kind,
        title: TITLES[r.kind]?.[req.ui_lang ?? 'zh'] ?? r.kind,
        text: r.text.trim(),
        citations,
      }))
    this.cache.set(message_id, { at: now, suggestions })
    return suggestions
  }

  /** 人挪了信 / 换了标签之后把缓存丢掉（下次打开重新生成）。 */
  invalidate(message_id: string): void {
    this.cache.delete(message_id)
  }
}

/* ── WP439：stub 剧本（没接真模型时三条建议怎么写） ───────────────────── */

/** 宿主的建议提示词里带这一句，stub 剧本据此认出「回复建议」那一次调用。 */
export const SUGGEST_PROMPT_MARKER = '你在帮一个人回一封邮件。'

const STUB_SUGGESTIONS: Readonly<Record<string, Record<ReplySuggestionKind, string>>> = {
  zh: {
    short: '收到，我们看一下，今天内回复你。',
    detailed:
      '感谢来信。我们已经在核对你提到的情况，确认后会把结果和下一步一起发给你，今天内会有回复。',
    decline: '感谢联系。这件事我们这边暂时没法安排，抱歉帮不上忙。',
  },
  en: {
    short: 'Thanks for reaching out. We are looking into it and will get back to you today.',
    detailed:
      'Thank you for your message. We are checking the details you mentioned and will send you the result and next steps today.',
    decline:
      "Thanks for getting in touch. Unfortunately we can't take this on right now — sorry we can't help.",
  },
}

/**
 * 认得出「回复建议」那一次（系统提示词里有 {@link SUGGEST_PROMPT_MARKER}）才回话，别的一律 `undefined`。
 * 按请求里的 `lang` 写（只备了中文与英文；别的语言按英文）。
 */
export function replySuggestStubScript(
  messages: readonly { role: string; content: unknown }[],
): string | undefined {
  const system = messages.find((m) => m.role === 'system')?.content
  if (typeof system !== 'string' || !system.includes(SUGGEST_PROMPT_MARKER)) return undefined
  const user = messages.find((m) => m.role === 'user')?.content
  let req: { lang?: unknown; kinds?: unknown } = {}
  try {
    req = JSON.parse(typeof user === 'string' ? user : '{}') as typeof req
  } catch {
    req = {}
  }
  const lang = typeof req.lang === 'string' ? req.lang : 'zh'
  const book =
    STUB_SUGGESTIONS[lang] ?? (lang.startsWith('zh') ? STUB_SUGGESTIONS.zh : STUB_SUGGESTIONS.en)
  const kinds = Array.isArray(req.kinds) ? req.kinds : SUGGESTION_KINDS
  return JSON.stringify(
    kinds
      .filter((k): k is ReplySuggestionKind => SUGGESTION_KINDS.includes(k as ReplySuggestionKind))
      .map((kind) => ({ kind, text: book?.[kind] ?? '' })),
  )
}
