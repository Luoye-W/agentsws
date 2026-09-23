/**
 * 模型验证三步（WP127，Luoye 09-23：只支持多模态）。
 *
 * 连通 → 一次最小文字请求 → **一次带图的最小请求**。向导第 ① 步与设置页「测试」
 * 走的是同一个 {@link checkModel}，模拟场景也是——分成几份的话，哪天改了一处
 * 另一处就会放进一个看不了图的模型。
 *
 * ## 为什么测试图上写的是一个词
 *
 * 考"看没看见"最省的办法是让它**念出图里的字**：一张几百字节的灰度图，上面用
 * 5×7 点阵画一个大写单词（{@link VISION_PROBE_WORD}）。看不了图的模型要么被上游
 * 直接 400（`image_url` 不认），要么回一句"我看不到图片"——它**猜不中**这个词；
 * 而问颜色 / 形状的话，瞎猜有三分之一的机会蒙对。
 *
 * ## 连通这一步不单独发请求
 *
 * 文字那一次请求本身就回答了"连不连得上"：上游回了任何 HTTP 响应（哪怕是 401）
 * 就是连上了；DNS / 拒绝连接 / 404 / 超时才是没连上。多发一次 `GET /models`
 * 不但多花一次往返，而且百炼那一路根本没有这个口。
 */
import {
  type ChatMessage,
  type ModelCheckStep,
  type ModelCheckStepResult,
  modelFailureKind,
  NO_VISION_REASON,
} from '@agentsws/contracts'
import { encodePng } from './images.js'

/** 测试图上写的那个词。选一个**蒙不中**的真单词：OCR 起来不含糊，瞎猜猜不到。 */
export const VISION_PROBE_WORD = 'ZEBRA'

/** 看图那一次的提问。 */
export const VISION_PROBE_PROMPT =
  '图里用大写字母写着一个英文单词。只回这个单词本身，不要加任何别的字。'

/** 网关拦下带图请求时（模型声明了看不了图）那句人话。全仓唯一一份。 */
export const CANNOT_SEE_IMAGES_ZH =
  '当前模型看不了图。Agents 工坊要求文字模型能看图——去设置 → 模型，换一个能看图的模型。'

/** 5×7 点阵：只画 {@link VISION_PROBE_WORD} 用得到的几个字母。 */
const GLYPHS: Record<string, readonly string[]> = {
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
}

const SCALE = 8
const GAP = 2 * SCALE
const PAD = 3 * SCALE

let cached: Uint8Array | undefined

/**
 * 那张测试图（灰度 PNG，白底黑字，几百字节）。确定性：同一份代码永远同一批字节，
 * 所以 stub 能按字节认出它（见 `stubProvider` 的 `vision` 选项）。
 */
export function visionProbePng(): Uint8Array {
  if (cached !== undefined) return cached
  const letters = [...VISION_PROBE_WORD].map((ch) => GLYPHS[ch] ?? GLYPHS.Z ?? [])
  const width = PAD * 2 + letters.length * 5 * SCALE + (letters.length - 1) * GAP
  const height = PAD * 2 + 7 * SCALE
  const row = width + 1
  const raw = new Uint8Array(row * height).fill(255)
  for (let y = 0; y < height; y += 1) raw[y * row] = 0 // 每行的过滤字节
  letters.forEach((glyph, i) => {
    const left = PAD + i * (5 * SCALE + GAP)
    glyph.forEach((line, gy) => {
      for (let gx = 0; gx < 5; gx += 1) {
        if (line[gx] !== '#') continue
        for (let dy = 0; dy < SCALE; dy += 1) {
          const y = PAD + gy * SCALE + dy
          for (let dx = 0; dx < SCALE; dx += 1) raw[y * row + 1 + left + gx * SCALE + dx] = 0
        }
      }
    })
  })
  cached = encodePng(width, height, raw, 'gray')
  return cached
}

/** 那张图的 base64（进 `ChatContentPart.data`，不带 `data:` 前缀）。 */
export function visionProbeBase64(): string {
  return Buffer.from(visionProbePng()).toString('base64')
}

/** 第 ② 步：最小文字请求（十来个 token）。 */
export function textProbeMessages(): ChatMessage[] {
  return [
    { role: 'system', content: '只回一个字：好' },
    { role: 'user', content: '在吗' },
  ]
}

/** 第 ③ 步：带图的最小请求。 */
export function visionProbeMessages(): ChatMessage[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: VISION_PROBE_PROMPT },
        { type: 'image', mime: 'image/png', data: visionProbeBase64() },
      ],
    },
  ]
}

/** 回的话里有没有那个词（大小写、标点、空格都不计较）。 */
export function visionProbePassed(text: string): boolean {
  return text
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .includes(VISION_PROBE_WORD)
}

/** 一条消息里带没带图（网关据此判要不要看能力声明）。 */
export function hasImagePart(messages: readonly ChatMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image'),
  )
}

/** 一次失败的"码 + 原文"。调用方各有各的钻法（网关把原文包在 `details.attempts` 里）。 */
export interface ModelCheckErrorView {
  reason: string
  detail: string
}

export interface ModelCheckOutcome {
  ok: boolean
  steps: ModelCheckStepResult[]
  /** 卡在哪一步。 */
  failed_step?: ModelCheckStep
  /** 没过时的码：`no_vision`（看不了图）或上游 / 网关那一次的错误码。 */
  reason?: string
  /** 没过时的原文（人话由调用方翻，见 `apps/server` 的 `humanizeModelError`）。 */
  detail?: string
  /** 第 ③ 步的结论：`true` 能看图，`false` 看不了；没跑到那一步就没有。 */
  vision?: boolean
  /** 文字那一次回的话（成功时给界面报"回了几个字"）。 */
  text?: string
  /** 两次请求合计的 token（成功时给界面报"用了多少"）。 */
  tokens: number
}

export interface CheckModelInput {
  /** 发一次请求。**经网关**——驻留、预算、价目表一并验证（"整条路通不通"）。 */
  complete(messages: ChatMessage[]): Promise<{
    text: string
    usage: { input_tokens: number; output_tokens: number }
  }>
  /** 把一个异常拆成码 + 原文。 */
  describe(error: unknown): ModelCheckErrorView
}

/**
 * 跑一遍三步。**不抛**：没过就回 `ok: false` + 卡在哪一步 + 码与原文。
 *
 * 第 ③ 步怎么判"看不了图"：
 * - 回了话但念不出那个词 → 看不了（它没看见，或者看见了也读不懂，都不合格）；
 * - 上游拒了（400 `image_url` 不认之类） → 看不了；
 * - **但**余额不足 / 超时 / 限流 这种与图无关的失败，照原样报那一档——
 *   把"余额不足"说成"看不了图"，用户会去换一个本来就能用的模型。
 */
export async function checkModel(input: CheckModelInput): Promise<ModelCheckOutcome> {
  let tokens = 0
  let first: string
  try {
    const res = await input.complete(textProbeMessages())
    tokens += res.usage.input_tokens + res.usage.output_tokens
    first = res.text
  } catch (e) {
    const view = input.describe(e)
    const kind = modelFailureKind(view)
    const unreachable = kind === 'address' || kind === 'timeout'
    return {
      ok: false,
      steps: unreachable
        ? [
            { step: 'connect', ok: false },
            { step: 'text', ok: false, skipped: true },
            { step: 'vision', ok: false, skipped: true },
          ]
        : [
            { step: 'connect', ok: true },
            { step: 'text', ok: false },
            { step: 'vision', ok: false, skipped: true },
          ],
      failed_step: unreachable ? 'connect' : 'text',
      reason: view.reason,
      detail: view.detail,
      tokens,
    }
  }

  const passedText: ModelCheckStepResult[] = [
    { step: 'connect', ok: true },
    { step: 'text', ok: true },
  ]
  try {
    const res = await input.complete(visionProbeMessages())
    tokens += res.usage.input_tokens + res.usage.output_tokens
    if (visionProbePassed(res.text)) {
      return {
        ok: true,
        steps: [...passedText, { step: 'vision', ok: true }],
        vision: true,
        text: first,
        tokens,
      }
    }
    return {
      ok: false,
      steps: [...passedText, { step: 'vision', ok: false }],
      failed_step: 'vision',
      reason: NO_VISION_REASON,
      detail: `图里写的是 ${VISION_PROBE_WORD}，模型回的是「${res.text.trim().slice(0, 60)}」`,
      vision: false,
      tokens,
    }
  } catch (e) {
    const view = input.describe(e)
    const kind = modelFailureKind(view)
    const unrelated = kind === 'balance' || kind === 'timeout' || /429/.test(view.detail)
    return {
      ok: false,
      steps: [...passedText, { step: 'vision', ok: false }],
      failed_step: 'vision',
      reason: unrelated ? view.reason : NO_VISION_REASON,
      detail: view.detail,
      ...(unrelated ? {} : { vision: false }),
      tokens,
    }
  }
}
