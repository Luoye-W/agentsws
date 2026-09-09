/**
 * 语义键：同一条经验换个说法也要认得出来，否则"五次相同纠正"会变成五条 lesson，
 * 而"被驳回过的不再提"也会被一次改写绕过（24 §6.3、WP29 场景 `learning/reject-once`）。
 *
 * 做法刻意简单、确定、可解释：中英混排粗分词 → 去停用词 → 去重排序 → 取前 12 个词 → 哈希。
 * 词序无关（"退款先看窗口" ≡ "先看窗口再退款"），措辞微调仍是同一把键。
 * 不用模型：键必须在没有网络、没有 key 的机器上也算得出同一个值。
 */
import { sha256 } from '@agentsws/core'
import { tokenize } from '@agentsws/skills'
import type { LessonKind } from './types.js'

/** 中英文里没有区分力的词。少而稳，不做成可配置项——键要跨版本稳定。 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'be',
  'to',
  'of',
  'and',
  'or',
  'in',
  'on',
  'for',
  'with',
  'that',
  'this',
  'it',
  'we',
  'you',
  'should',
  'please',
  '的',
  '了',
  '是',
  '在',
  '和',
  '与',
  '这',
  '那',
  '要',
  '把',
  '给',
  '就',
  '也',
  '都',
  '，',
  '。',
  '、',
  '；',
  '：',
  '！',
  '？',
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
])

/** 参与哈希的最多词数：太少会把不同经验并成一条，太多会让一次措辞改动换掉键。 */
export const KEY_TOKEN_CAP = 12

/** 文本 → 规范化词袋（去停用词、去重、排序）。导出给测试与解释用。 */
export function keyTokens(text: string): string[] {
  const seen = new Set<string>()
  for (const t of tokenize(text)) {
    if (STOP_WORDS.has(t)) continue
    seen.add(t)
  }
  return [...seen].sort().slice(0, KEY_TOKEN_CAP)
}

/**
 * 语义键 = `(skill, section, kind, 词袋哈希)`。
 *
 * 段 id 进键：同一句话落到不同段上是两条不同的建议（一条改"退货窗口"，一条改"语气"）。
 */
export function semanticKey(input: {
  skill: string
  section_id?: string
  kind: LessonKind
  text: string
}): string {
  const tokens = keyTokens(input.text)
  const digest = sha256(tokens.join(' ')).slice(0, 16)
  return `${input.skill}::${input.section_id ?? ''}::${input.kind}::${digest}`
}

/** 词袋重合度（0..1）：合并时用来判"够不够像"。 */
export function keySimilarity(a: string, b: string): number {
  const sa = new Set(keyTokens(a))
  const sb = new Set(keyTokens(b))
  if (sa.size === 0 && sb.size === 0) return 1
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter += 1
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}
