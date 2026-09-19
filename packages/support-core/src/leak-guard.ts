/**
 * WP125（72 §2.2 第 1 条 / §P0-2 第二条）：**教 AI 的指导原文泄漏守卫**。
 *
 * 移植自 KefuAgent `src/lib/support/chat.ts:517` 的 `containsInstructionVerbatimLeak`。
 *
 * 为什么非有不可：商家用中文教 AI 怎么答（「按 14 天窗口跟他说」），这句话进 prompt、
 * **永不进 `bodyText`**。但"prompt 里写了不要照抄"不是保证——模型只要复述一次，
 * 商家的中文原话就出现在外国客户的屏幕上，而且**撤不回来**。
 *
 * 判据（与 KefuAgent 逐条对齐）：
 *
 * 1. 两侧先**归一化空白**（连续空白折成一个空格、去首尾、转小写）——
 *    模型换个换行位置不该让守卫失效；
 * 2. 指导 ≤ {@link LEAK_VERBATIM_MIN_CHARS} 字：整串包含即判泄漏
 *    （短句只可能是照抄，不可能是巧合）；
 * 3. 更长：取两侧的**最长公共连续子串**，长度 ≥ 阈值即判泄漏
 *    （模型常见的做法是抄一半、改一半）。
 *
 * 命中之后不是"删掉那一段照发"——调用方要么重写一次，要么转人工审
 * （见 {@link evaluateLeakGuard} 的 `action`）。静默删改是最坏的那一种：
 * 商家以为 AI 按他说的答了，客户收到的是一句缺了半截的话。
 *
 * 纯函数、无 IO。**被扫的文本不进任何返回值**——返回的只有长度与结论，
 * 这样调用方把它写进审计行时不会把商家的原话一起写进去（同 gates 的纪律）。
 */

/** 短于等于这个长度的指导用「整串包含」判；更长的用最长公共连续子串。 */
export const LEAK_VERBATIM_MIN_CHARS = 12

/** 一次重写机会：再命中就转人工审，不再让模型试第三次。 */
export const LEAK_MAX_REWRITES = 1

/** 归一化：连续空白折成一个空格、去首尾、转小写。 */
export function normalizeForLeakCheck(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 最长公共连续子串的长度。
 *
 * 滚动一维 DP：两侧都是一条回复 / 一句指导的量级（数百字），O(n·m) 足够，
 * 而且没有隐藏的分配——后缀自动机那种写法在这个尺度上只会更难读。
 */
export function longestCommonSubstringLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  let best = 0
  let prev = new Uint32Array(b.length + 1)
  let cur = new Uint32Array(b.length + 1)
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        const run = (prev[j - 1] ?? 0) + 1
        cur[j] = run
        if (run > best) best = run
      } else {
        cur[j] = 0
      }
    }
    const swap = prev
    prev = cur
    cur = swap
    cur.fill(0)
  }
  return best
}

/**
 * 这条回复里有没有逐字引用商家那句指导。
 *
 * @param reply 拟发给客户的回复
 * @param instruction 商家教 AI 的那句话（可以给多条，任意一条命中即泄漏）
 */
export function containsInstructionVerbatimLeak(
  reply: string,
  ...instructions: (string | undefined)[]
): boolean {
  return leakMatchLength(reply, ...instructions) > 0
}

/** 命中的那一段有多长（0 = 没泄漏）。**不返回那一段的内容**。 */
export function leakMatchLength(reply: string, ...instructions: (string | undefined)[]): number {
  const haystack = normalizeForLeakCheck(reply)
  if (haystack.length === 0) return 0
  let worst = 0
  for (const raw of instructions) {
    if (raw === undefined) continue
    const needle = normalizeForLeakCheck(raw)
    if (needle.length === 0) continue
    if (needle.length <= LEAK_VERBATIM_MIN_CHARS) {
      if (haystack.includes(needle) && needle.length > worst) worst = needle.length
      continue
    }
    const run = longestCommonSubstringLength(haystack, needle)
    if (run >= LEAK_VERBATIM_MIN_CHARS && run > worst) worst = run
  }
  return worst
}

export type LeakAction = 'send' | 'rewrite' | 'human_review'

export interface LeakGuardResult {
  leaked: boolean
  /** 命中片段的长度（只有长度，**没有内容**）。 */
  matched_chars: number
  /** 这次该怎么办：第一次命中重写一版，再命中转人工审。 */
  action: LeakAction
  /** 已经重写过几次（调用方传进来的那个数，原样回给它做下一轮的输入）。 */
  rewrites: number
}

export interface LeakGuardInput {
  /** 拟发给客户的回复。 */
  reply: string
  /** 商家教 AI 的那一句 / 那几句。 */
  instructions: readonly (string | undefined)[]
  /** 这条回复已经因为泄漏被重写过几次；默认 0。 */
  rewrites?: number
}

/**
 * 投递前的那一道：判泄漏 + 决定「发 / 重写 / 转人工审」。
 *
 * 顺序是硬的——**在自主门之前**跑。理由：泄漏是一条"这封根本不该长这样"的判据，
 * 让它先说话，三道门就不必去解释一封注定要重写的草稿。
 */
export function evaluateLeakGuard(input: LeakGuardInput): LeakGuardResult {
  const rewrites = input.rewrites ?? 0
  const matched_chars = leakMatchLength(input.reply, ...input.instructions)
  if (matched_chars === 0) {
    return { leaked: false, matched_chars: 0, action: 'send', rewrites }
  }
  return {
    leaked: true,
    matched_chars,
    action: rewrites >= LEAK_MAX_REWRITES ? 'human_review' : 'rewrite',
    rewrites,
  }
}

/** 重写时递给模型的那一句（不含商家原话——模型本来就拿得到它）。 */
export const LEAK_REWRITE_INSTRUCTION =
  '上一版回复里照抄了商家那句内部指导的原文。商家的话是给你的口径，不是给客户看的文字：' +
  '用客户自己的语言重写一版，说同一个意思，一个字都不要引用那句指导。'
