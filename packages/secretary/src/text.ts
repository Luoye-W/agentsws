/**
 * 秘书用的一点文本判断。
 *
 * 刻意做得**简单、确定、可解释**：没有模型也要能跑（41 §1.4 里秘书用的是同一套运行协议，
 * 但"这句话在问什么"这种判断不该等模型——没配 key 的机器上秘书照样得能答"他在忙什么"）。
 * 装了模型的部署把同一份事实交给模型润色，判据仍是这里算出来的。
 */

/** 归一：小写、去掉空白与常见标点之间的差异。中文不分词——按整词包含判。 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[，,、；;：:]/g, '、')
}

/** 把一句描述切成短语（职责的 `description` 就是用顿号连起来的一串"管什么"）。 */
export function splitPhrases(text: string): string[] {
  return text
    .split(/[、，,;；。/|]|\s+|与|和|及/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 判据词命中：长度 ≥ 2 的按整词包含；单字词（`退`）只在显式声明时用，权重由调用方压低。 */
export function containsTerm(normalizedText: string, term: string): boolean {
  const t = normalize(term)
  return t.length > 0 && normalizedText.includes(t)
}

const QUESTION_CUES = [
  '能不能',
  '可不可以',
  '可以吗',
  '行不行',
  '行吗',
  '是不是',
  '有没有',
  '怎么办',
  '怎么',
  '如何',
  '为什么',
  '多少',
  '哪些',
  '哪个',
  '什么时候',
  '算不算',
  '要不要',
  '吗',
  'whether',
  'how',
  'why',
  'what',
  'can we',
  'canwe',
  'should',
]

/**
 * 这句话是在**问**还是在**派活**。
 *
 * 41 §1.4：「退货窗口外能不能退？」是专业问题（转岗位 Agent），
 * 「把这个客户投诉处理一下」是一件活（出认领卡）。分不清就当成活——
 * 出一张等人认领的卡，比替人回答一个专业问题安全得多。
 */
export function looksLikeQuestion(text: string): boolean {
  const raw = text.trim()
  if (raw === '') return false
  if (/[?？]\s*$/.test(raw)) return true
  const n = normalize(raw)
  return QUESTION_CUES.some((cue) => n.includes(normalize(cue)))
}
