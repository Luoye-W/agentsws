/**
 * WP250（决策 103）：认「默认文字」只比哈希，不存原文。
 *
 * 官方文案（生成时临时取）与页面文字走**同一套**切句 + 归一 + 哈希，再比哈希：
 * 1. 切句：先 NFKC（全角标点转半角），按句末标点切——`。` `!` `?`，以及后面跟空白或到头的 `.`
 *    （`19.99`、`image(s)` 不会被切开）。换行不切：页面上一句话常被排版拆成两行。
 * 2. 归一（{@link normalizeForMatch}）：去标签、解实体、NFKC、小写，再去掉所有空白与标点。
 * 3. 哈希：SHA-256 取前 16 个十六进制字符。
 *
 * 一段官方文案切出几句就有几个哈希；页面上每个文本节点同样切句算哈希，
 * 官方那几句**全在**页面里才算对上（整段照搬、被拆进几个节点、或嵌在更长的一段里都认得出）。
 */
import { createHash } from 'node:crypto'
import { decodeEntities } from './html.js'

/** 去标签、解实体、全角转半角（NFKC）、小写，再把空白与标点全去掉——只比字母和数字。 */
export function normalizeForMatch(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' '))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 一段**纯文字**（不带标签）切成句，每句归一；空句丢掉。 */
export function sentencesOf(text: string): string[] {
  return text
    .normalize('NFKC')
    .split(/[。!?]|\.(?=\s|$)/u)
    .map(normalizeForMatch)
    .filter((s) => s !== '')
}

/** 一句归一后的文字 → 16 位哈希。 */
export function hashSentence(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}

/** 一段官方文案（可能带 `<p>`）→ 它每一句的哈希。生成脚本用它，和页面那边同一套规则。 */
export function textHashes(value: string): string[] {
  return sentencesOf(decodeEntities(value.replace(/<[^>]*>/g, ' '))).map(hashSentence)
}

/** 页面上每个文本节点切句后的哈希（脚本 / 样式 / noscript 里的不算）。 */
export function pageSentenceHashes(html: string): Set<string> {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  const out = new Set<string>()
  for (const node of body.split(/<[^>]*>/)) {
    if (node.trim() === '') continue
    for (const s of sentencesOf(decodeEntities(node))) out.add(hashSentence(s))
  }
  return out
}
