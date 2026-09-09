/**
 * 通用导入格式解析（37 §4.2 第三方工具接入的 v1 做法）。
 *
 * 四种，都是纯函数、无 IO：
 * - **SRT**（`1 / 00:00:01,000 --> 00:00:04,000 / 正文`）
 * - **WebVTT**（`WEBVTT` 头、`00:00:01.000 --> 00:00:04.000`、`<v 张三>正文`）
 * - **说话人块**（Otter / 妙记 / 腾讯会议的 txt 导出：`张三 0:12` 一行，正文若干行）
 * - **纯文本**（`张三：正文` 或没有说话人的自由文本）
 *
 * 统一回 `MeetingTranscript`。解析器只认结构，不认内容——内容一律当不可信数据，
 * 到管线里再过围栏。
 */
import type { MeetingTranscript, TranscriptSegment } from '@agentsws/contracts'

export type TranscriptFormat = 'srt' | 'vtt' | 'speaker_blocks' | 'plain'

const TIME_RANGE =
  /^\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})/
/** 猜格式时要跨行找 `-->`（逐行解析用的是上面那个带 `^` 的）。 */
const TIME_RANGE_ANYWHERE = new RegExp(TIME_RANGE.source, 'm')
/** `张三 0:12` / `Alice Chen  00:01:03` —— 说话人 + 时间戳独占一行。 */
const SPEAKER_STAMP = /^\s*(.{1,40}?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/
/** `张三：正文` / `Bob: text` */
const SPEAKER_COLON = /^\s*([^:：]{1,24})\s*[:：]\s*(.*)$/u
const VTT_VOICE = /^<v\s+([^>]{1,40})>\s*(.*?)(?:<\/v>)?\s*$/

/** `00:01:02,500` / `01:02.500` / `1:03` → 毫秒。 */
export function parseTimestamp(raw: string): number {
  const [clock = '', frac = '0'] = raw.trim().replace(',', '.').split('.')
  const parts = clock.split(':').map((p) => Number.parseInt(p, 10))
  let seconds = 0
  for (const p of parts) seconds = seconds * 60 + (Number.isNaN(p) ? 0 : p)
  return seconds * 1000 + Number.parseInt(frac.padEnd(3, '0').slice(0, 3), 10)
}

/** 猜格式。看不出来就是 `plain`。 */
export function detectFormat(text: string): TranscriptFormat {
  if (/^﻿?WEBVTT/m.test(text)) return 'vtt'
  if (TIME_RANGE_ANYWHERE.test(text)) return 'srt'
  const lines = text.split(/\r?\n/)
  if (lines.some((l) => SPEAKER_STAMP.test(l))) return 'speaker_blocks'
  return 'plain'
}

function cueBlocks(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((l) => l.trim() !== ''))
    .filter((block) => block.length > 0)
}

/** SRT 与 VTT 共用：找到 `-->` 那行，前面是序号 / cue id，后面是正文。 */
function parseCues(text: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  for (const block of cueBlocks(text)) {
    const idx = block.findIndex((l) => TIME_RANGE.test(l))
    if (idx < 0) continue
    const m = TIME_RANGE.exec(block[idx] as string)
    if (m === null) continue
    const body = block.slice(idx + 1)
    if (body.length === 0) continue
    let speaker: string | undefined
    const cleaned = body.map((line) => {
      const voice = VTT_VOICE.exec(line.trim())
      if (voice !== null) {
        speaker ??= voice[1]?.trim()
        return voice[2] ?? ''
      }
      const colon = SPEAKER_COLON.exec(line)
      if (colon !== null && speaker === undefined) {
        speaker = colon[1]?.trim()
        return colon[2] ?? ''
      }
      return line.trim()
    })
    const joined = cleaned.join(' ').trim()
    if (joined === '') continue
    segments.push({
      start_ms: parseTimestamp(m[1] as string),
      end_ms: parseTimestamp(m[2] as string),
      ...(speaker === undefined || speaker === '' ? {} : { speaker }),
      text: joined,
    })
  }
  return segments
}

/** Otter / 妙记 / 腾讯会议 txt：`说话人 时间戳` 一行，正文若干行。 */
function parseSpeakerBlocks(text: string): TranscriptSegment[] {
  const lines = text.split(/\r?\n/)
  const segments: TranscriptSegment[] = []
  let current: { speaker: string; start_ms: number; body: string[] } | undefined
  const flush = (): void => {
    if (current === undefined) return
    const body = current.body.join(' ').trim()
    if (body !== '')
      segments.push({
        start_ms: current.start_ms,
        end_ms: current.start_ms,
        speaker: current.speaker,
        text: body,
      })
    current = undefined
  }
  for (const line of lines) {
    const m = SPEAKER_STAMP.exec(line)
    if (m !== null) {
      flush()
      current = { speaker: (m[1] ?? '').trim(), start_ms: parseTimestamp(m[2] ?? '0'), body: [] }
      continue
    }
    if (line.trim() === '') continue
    if (current === undefined) continue
    current.body.push(line.trim())
  }
  flush()
  // 末段的 end_ms 用下一段的 start_ms 补，最后一段给 0 长度
  return segments.map((s, i) => ({ ...s, end_ms: segments[i + 1]?.start_ms ?? s.start_ms }))
}

/** 纯文本：`张三：正文` 认说话人，其余整行当正文；没有时间戳。 */
function parsePlain(text: string): TranscriptSegment[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((line) => {
      const m = SPEAKER_COLON.exec(line)
      const speaker = m?.[1]?.trim()
      const body = m?.[2]?.trim()
      return {
        start_ms: 0,
        end_ms: 0,
        ...(speaker === undefined || body === undefined || body === '' ? {} : { speaker }),
        text: speaker !== undefined && body !== undefined && body !== '' ? body : line,
      }
    })
}

export interface ParseTranscriptOptions {
  /** 强制格式；不给就 `detectFormat`。 */
  format?: TranscriptFormat
  language?: string
}

/** 任意导入文本 → `MeetingTranscript`。空输入回 undefined（不造空记录）。 */
export function parseTranscript(
  text: string,
  options: ParseTranscriptOptions = {},
): MeetingTranscript | undefined {
  if (text.trim() === '') return undefined
  const format = options.format ?? detectFormat(text)
  const segments =
    format === 'srt' || format === 'vtt'
      ? parseCues(text)
      : format === 'speaker_blocks'
        ? parseSpeakerBlocks(text)
        : parsePlain(text)
  if (segments.length === 0) return undefined
  const speakers = [...new Set(segments.map((s) => s.speaker).filter((s) => s !== undefined))]
  return {
    text: segments
      .map((s) => (s.speaker === undefined ? s.text : `${s.speaker}：${s.text}`))
      .join('\n'),
    segments,
    ...(speakers.length === 0 ? {} : { speakers: speakers as string[] }),
    ...(options.language === undefined ? {} : { language: options.language }),
  }
}

/**
 * 交过来的文档 → 纯文本。v1 只做两件事：markdown 去格式、HTML 去标签。
 * （anydoc 还没接进仓库；接进来后这里换成它，见报告 §6。）
 */
export function documentToText(input: string, mime?: string): string {
  const isHtml = mime === 'text/html' || /^\s*<(!doctype|html)\b/i.test(input)
  let text = input
  if (isHtml) {
    text = text
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  }
  return text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')
    .replace(/```[\w-]*\n?/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .trim()
}
