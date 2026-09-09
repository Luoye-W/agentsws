/**
 * 26 §模拟替身：确定性 ASR（WP23）。同一 (bytes, mime, language, seed) 必然同一份转写。
 *
 * 两种模式，都是确定性的：
 * - **回声档（默认）**：字节能按 UTF-8 解出可读文本时，直接把它当作"这段音频说了什么"。
 *   合成样本因此可以把台词写进 `bytes`，测试断言的是**管线**而不是 ASR 质量。
 * - **词表档**：字节不是文本（真二进制）时，按 sha256 + seed 从固定词表里生成句子。
 *
 * 说话人切分：按空行 / `姓名：` 前缀切段；没有前缀就全归 `speaker_1`。
 */
import type { ModelProvider, ModelRef, ProviderTranscription } from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'

export interface StubAsrProviderOptions {
  seed: number
  ref?: ModelRef
  /** 每段假定的时长（毫秒），默认 4000。 */
  segmentMs?: number
}

const VOCAB = [
  '我们决定下周一上线新版落地页',
  '这条我来跟进',
  '退货窗口按十四天算',
  '下次会议定在周五下午三点',
  '物流那边还没回复',
  '预算先按上个月的来',
  'we agreed to ship on friday',
  'i will follow up with the supplier',
]

const byte = (hash: string, i: number): number => Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16)

const decoder = new TextDecoder('utf-8', { fatal: true })

/** 字节能解成可读文本就用它；否则回 undefined（走词表档）。 */
export function decodeReadableText(bytes: Uint8Array): string | undefined {
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    return undefined
  }
  if (text.trim().length === 0) return undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 判定「是不是可读文本」必须看控制字符
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) return undefined
  return text
}

const SPEAKER_LINE = /^\s*([\p{L}\p{N}_. -]{1,24})\s*[:：]\s*(.*)$/u

/** 一段文本 → 段落（说话人 + 起止毫秒）。给 stub 与第三方纯文本导入共用。 */
export function segmentText(
  text: string,
  segmentMs: number,
): { start_ms: number; end_ms: number; speaker?: string; text: string }[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return lines.map((line, i) => {
    const m = SPEAKER_LINE.exec(line)
    const speaker = m?.[1]
    const body = m?.[2]
    return {
      start_ms: i * segmentMs,
      end_ms: (i + 1) * segmentMs,
      ...(speaker === undefined || body === undefined || body.length === 0
        ? {}
        : { speaker: speaker.trim() }),
      text: speaker !== undefined && body !== undefined && body.length > 0 ? body : line,
    }
  })
}

export function stubAsrProvider(options: StubAsrProviderOptions): ModelProvider {
  const ref: ModelRef = options.ref ?? { provider: 'stub', model: 'stub-asr-v1', region: 'cn' }
  const segmentMs = options.segmentMs ?? 4000

  return {
    ref,
    // ASR-only provider：不做补全（网关不会给它 complete 的活，除非路由配错了）
    async complete() {
      throw new Error('stub-asr provider does not implement complete')
    },
    async transcribe(audio): Promise<ProviderTranscription> {
      const readable = decodeReadableText(audio.bytes)
      const hash = sha256(
        `${options.seed}:${audio.mime}:${audio.language ?? ''}:${bytesKey(audio.bytes)}`,
      )
      const text =
        readable ??
        Array.from({ length: 3 }, (_, i) => VOCAB[byte(hash, i) % VOCAB.length] ?? '').join('\n')
      const segments = segmentText(text, segmentMs)
      const speakers = [
        ...new Set(segments.map((s) => s.speaker).filter((s): s is string => s !== undefined)),
      ]
      return {
        text,
        segments,
        ...(speakers.length === 0 ? {} : { speakers }),
        ...(audio.language === undefined ? {} : { language: audio.language }),
        usage: {
          // ASR 按音频秒数计价：这里把"秒"记进 input_tokens（价目表同一套换算，见 README）
          input_tokens: Math.max(1, Math.ceil((segments.length * segmentMs) / 1000)),
          output_tokens: Math.ceil(text.length / 4),
          cached_tokens: 0,
        },
      }
    },
  }
}

function bytesKey(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return sha256(out)
}
