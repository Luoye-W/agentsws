/**
 * WP467：**人自己发出去的那一条算不算这条草稿**（插件自动记录、本机服务回写「已记录」共用一把尺子）。
 *
 * 认法（Luoye 10-22）：在**这个帖子**里（错帖不记，调用方先按帖子 id 筛）+ **文本相近** + 当前登录的那个号发的。
 * 文本相近按「词」算重合度（英文按词、中日韩按相邻两个字），去掉 Markdown 记号与标点——Reddit 会把 `**粗**`、
 * 链接、换行渲染掉，页面上的字和草稿原文不会一字不差；人改了几个词也照样认。
 */

import { postedKey } from '../dom.js'

/** 去掉 Markdown 记号（链接留文字），再拆成「词」。 */
function tokensOf(s: string): string[] {
  const plain = s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/[*_~`>#|]/gu, ' ')
    .toLowerCase()
  const out: string[] = []
  for (const word of plain.split(/[^\p{L}\p{N}]+/u)) {
    if (word === '') continue
    // 中日韩连着写没有空格：按相邻两个字切
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)) {
      const chars = [...word]
      if (chars.length === 1) out.push(word)
      for (let i = 0; i + 1 < chars.length; i += 1) out.push(`${chars[i]}${chars[i + 1]}`)
      continue
    }
    out.push(word)
  }
  return out
}

/** 两段字有多像（0–1，Dice 系数，按词的多重集合算）。 */
export function draftSimilarity(a: string, b: string): number {
  const x = tokensOf(a)
  const y = tokensOf(b)
  if (x.length === 0 || y.length === 0) return 0
  const count = new Map<string, number>()
  for (const t of x) count.set(t, (count.get(t) ?? 0) + 1)
  let both = 0
  for (const t of y) {
    const n = count.get(t) ?? 0
    if (n > 0) {
      both += 1
      count.set(t, n - 1)
    }
  }
  return (2 * both) / (x.length + y.length)
}

/**
 * 草稿里的词有多少出现在页面上那一条里（0–1）。页面上多出来的（翻译插件插进来的译文、人补的一句）不扣分。
 */
export function draftCoverage(draft: string, said: string): number {
  const x = tokensOf(draft)
  if (x.length === 0) return 0
  const count = new Map<string, number>()
  for (const t of tokensOf(said)) count.set(t, (count.get(t) ?? 0) + 1)
  let hit = 0
  for (const t of x) {
    const n = count.get(t) ?? 0
    if (n > 0) {
      hit += 1
      count.set(t, n - 1)
    }
  }
  return hit / x.length
}

/** 认得出是这个号发的时，相近到这个程度就算（人改了几个词）。 */
export const SENT_MATCH_WITH_AUTHOR = 0.6
/** 不知道是谁发的时要更像（基本没改）。 */
export const SENT_MATCH_WITHOUT_AUTHOR = 0.85

/**
 * 页面上这一条是不是这条草稿发出去的样子。`me` = 当前登录的号（不知道就不给）；`author` = 页面上这一条是谁发的。
 * 知道是谁登着、又看得到这一条是谁发的，**不是同一个号就不认**。
 */
export function looksLikeSent(input: {
  draft: string
  said: string
  me?: string | undefined
  author?: string | undefined
}): boolean {
  const said = input.said.trim()
  if (said === '' || input.draft.trim() === '') return false
  const me = input.me
    ?.replace(/^\/?u\//u, '')
    .trim()
    .toLowerCase()
  const by = input.author
    ?.replace(/^\/?u\//u, '')
    .trim()
    .toLowerCase()
  if (me !== undefined && me !== '' && by !== undefined && by !== '' && me !== by) return false
  const mine = me !== undefined && me !== '' && by === me
  // 一字不差（去掉标点空白）：短短一句「谢谢」也认
  if (postedKey(said) === postedKey(input.draft)) return true
  const need = mine ? SENT_MATCH_WITH_AUTHOR : SENT_MATCH_WITHOUT_AUTHOR
  if (draftSimilarity(input.draft, said) >= need) return true
  // 页面上那一条比草稿长很多（插进了译文 / 人补了几句）：看草稿的词是不是都在里面；长出三倍以上的不算
  return (
    tokensOf(said).length <= tokensOf(input.draft).length * 3 &&
    draftCoverage(input.draft, said) >= need
  )
}
