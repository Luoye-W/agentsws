/**
 * 六种记录来源（37 §4.1），每种一个 `MeetingRecordSource`（23 扩展点 `meeting.record_source`）。
 *
 * 免费默认版的 v1 边界，逐条写死在这里，第三方 / 付费增强按同一接口替换或叠加：
 *
 * | 来源 | v1 做到哪 | 付费增强 / 第三方接着做什么 |
 * |---|---|---|
 * | `handed_over` | 粘贴文本、上传文档（markdown / HTML / txt）→ 抽文本 | 接 anydoc：PDF / Word / 飞书文档 |
 * | `manual_notes` | 人手写的笔记直接入库 | — |
 * | `in_app_recording` | 浏览器 / 桌面壳 MediaRecorder 上传的音频块 → 受控区 → 转写 | 实时增量转写、说话人分离 |
 * | `device` | 目录 / 上传导入（音频或转写文本），Plaud 等 | 设备自动同步、云端账号拉取 |
 * | `third_party` | 通用导入格式：SRT / VTT / Otter / 妙记 的导出 | 各家 API 自动同步 |
 * | `online_meeting` | 导入平台导出的转写 / 录制文件 | **实时 bot 自动入会**（付费增强） |
 */
import type {
  MeetingRecordDraft,
  MeetingRecordSource,
  MeetingSourceContext,
} from '@agentsws/contracts'
import { MeetingError } from '../errors.js'
import {
  documentToText,
  type ParseTranscriptOptions,
  parseTranscript,
  type TranscriptFormat,
} from './formats.js'

export * from './formats.js'

/** 上传 / 粘贴类来源的统一载荷。 */
export interface UploadPayload {
  /** 粘贴的文本 / 导入文件的文本内容。 */
  text?: string
  /** 上传的字节（录音块、设备音频文件）。 */
  bytes?: Uint8Array
  mime?: string
  name?: string
  language?: string
  format?: TranscriptFormat
  meeting_id?: string
  /** 录音告知（外部人在场时必须给 true，否则转写会被拒）。 */
  notice_given?: boolean
  recorded_by?: string
  note?: string
}

function payloadOf(payload: unknown): UploadPayload {
  if (payload === null || typeof payload !== 'object')
    throw new MeetingError('invalid_input', '记录载荷必须是一个对象')
  return payload as UploadPayload
}

function consentOf(p: UploadPayload, ctx: MeetingSourceContext): MeetingRecordDraft['consent'] {
  return {
    recorded_by: p.recorded_by ?? ctx.actor,
    notice_given: p.notice_given === true,
  }
}

function common(p: UploadPayload): Pick<MeetingRecordDraft, 'meeting_id' | 'note'> {
  return {
    ...(p.meeting_id === undefined ? {} : { meeting_id: p.meeting_id }),
    ...(p.note === undefined ? {} : { note: p.note }),
  }
}

function textDraft(
  source: MeetingRecordDraft['source'],
  text: string,
  p: UploadPayload,
  ctx: MeetingSourceContext,
  parseOptions: ParseTranscriptOptions = {},
): MeetingRecordDraft[] {
  const transcript = parseTranscript(text, {
    ...parseOptions,
    ...(p.format === undefined ? {} : { format: p.format }),
    ...(p.language === undefined ? {} : { language: p.language }),
  })
  if (transcript === undefined)
    throw new MeetingError('invalid_input', '这份记录里没有可用的文本', { source })
  return [
    {
      source,
      transcript,
      // 原文也进受控区：产出的每条出处都要能回到原始材料（19 §1.1 provenance）
      bytes: new TextEncoder().encode(text),
      mime: p.mime ?? 'text/plain',
      ...(p.name === undefined ? {} : { name: p.name }),
      consent: consentOf(p, ctx),
      ...common(p),
    },
  ]
}

/* ------------------------------------------------------------------ */
/* ① handed_over：别人给过来的记录（粘贴 / 上传文档）                       */
/* ------------------------------------------------------------------ */

export function handedOverSource(): MeetingRecordSource {
  return {
    id: 'agentsws/handed-over',
    kind: 'handed_over',
    mode: 'manual',
    accept(payload, ctx) {
      const p = payloadOf(payload)
      const raw = p.text ?? (p.bytes === undefined ? undefined : new TextDecoder().decode(p.bytes))
      if (raw === undefined)
        throw new MeetingError('invalid_input', '交过来的记录既没有文本也没有文件内容')
      return textDraft('handed_over', documentToText(raw, p.mime), p, ctx)
    },
  }
}

/* ------------------------------------------------------------------ */
/* ② manual_notes：人手写的笔记                                          */
/* ------------------------------------------------------------------ */

export function manualNotesSource(): MeetingRecordSource {
  return {
    id: 'agentsws/manual-notes',
    kind: 'manual_notes',
    mode: 'manual',
    accept(payload, ctx) {
      const p = payloadOf(payload)
      if (p.text === undefined || p.text.trim() === '')
        throw new MeetingError('invalid_input', '笔记是空的')
      // 笔记就是笔记，不猜格式（人写的冒号不一定是说话人）
      return textDraft('manual_notes', p.text, p, ctx, { format: 'plain' })
    },
  }
}

/* ------------------------------------------------------------------ */
/* ③ in_app_recording：一键录音（浏览器 / 桌面壳 MediaRecorder）           */
/* ------------------------------------------------------------------ */

/**
 * 前端每录一段就 POST 一块；`chunk_index` 递增，`final` 为 true 时收尾。
 * v1 在服务端把块按序拼起来再整体转写（实时增量转写属付费增强）。
 */
export interface RecordingChunkPayload extends UploadPayload {
  bytes: Uint8Array
  chunk_index?: number
  final?: boolean
}

export interface InAppRecordingSource extends MeetingRecordSource {
  /** 收一块；回 true 表示这是最后一块（可以出草稿了）。 */
  push(key: string, chunk: RecordingChunkPayload): boolean
  /** 把攒着的块拼成一份草稿并清空缓冲。 */
  finish(key: string, p: RecordingChunkPayload, ctx: MeetingSourceContext): MeetingRecordDraft[]
  pending(key: string): number
}

export function inAppRecordingSource(): InAppRecordingSource {
  const buffers = new Map<string, { index: number; bytes: Uint8Array }[]>()

  const source: InAppRecordingSource = {
    id: 'agentsws/in-app-recording',
    kind: 'in_app_recording',
    mode: 'push',
    push(key, chunk) {
      const list = buffers.get(key) ?? []
      list.push({ index: chunk.chunk_index ?? list.length, bytes: chunk.bytes })
      buffers.set(key, list)
      return chunk.final === true
    },
    pending(key) {
      return buffers.get(key)?.length ?? 0
    },
    finish(key, p, ctx) {
      const list = buffers.get(key) ?? []
      buffers.delete(key)
      const ordered = [...list].sort((a, b) => a.index - b.index)
      const total = ordered.reduce((n, c) => n + c.bytes.byteLength, 0)
      if (total === 0) throw new MeetingError('invalid_input', '这次录音没有收到任何音频')
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const c of ordered) {
        bytes.set(c.bytes, offset)
        offset += c.bytes.byteLength
      }
      return [
        {
          source: 'in_app_recording',
          bytes,
          mime: p.mime ?? 'audio/webm',
          ...(p.name === undefined ? {} : { name: p.name }),
          consent: consentOf(p, ctx),
          ...common(p),
        },
      ]
    },
    accept(payload, ctx) {
      const p = payloadOf(payload) as RecordingChunkPayload
      if (!(p.bytes instanceof Uint8Array))
        throw new MeetingError('invalid_input', '录音块必须带字节')
      const key = `${ctx.workspace_id}:${p.meeting_id ?? 'unbound'}`
      // 单块直传（没给 chunk_index / final 时按"一次录完"处理）
      const last = source.push(key, { ...p, final: p.final ?? p.chunk_index === undefined })
      return last ? source.finish(key, p, ctx) : []
    },
  }
  return source
}

/* ------------------------------------------------------------------ */
/* ④ device：外出录音设备（Plaud 等）                                     */
/* ------------------------------------------------------------------ */

/** 设备目录的最小读口（注入，便于测试；生产实现给真 `node:fs`）。 */
export interface DeviceFolder {
  list(): Promise<{ name: string; mime?: string }[]> | { name: string; mime?: string }[]
  read(name: string): Promise<Uint8Array> | Uint8Array
}

export interface DeviceSourceOptions {
  folder?: DeviceFolder
  /** 已经同步过的文件名（宿主传进来做去重）。 */
  seen?: Set<string>
}

const TEXT_EXT = /\.(txt|md|srt|vtt|json)$/i

export function deviceSource(options: DeviceSourceOptions = {}): MeetingRecordSource {
  const seen = options.seen ?? new Set<string>()
  return {
    id: 'agentsws/device-folder',
    kind: 'device',
    mode: 'device_sync',
    accept(payload, ctx) {
      const p = payloadOf(payload)
      if (p.text !== undefined) return textDraft('device', p.text, p, ctx)
      if (p.bytes === undefined)
        throw new MeetingError('invalid_input', '设备记录既没有文本也没有音频')
      return [
        {
          source: 'device',
          bytes: p.bytes,
          mime: p.mime ?? 'audio/mpeg',
          ...(p.name === undefined ? {} : { name: p.name }),
          consent: consentOf(p, ctx),
          ...common(p),
        },
      ]
    },
    async sync(ctx) {
      const folder = options.folder
      if (folder === undefined)
        throw new MeetingError('not_implemented', '没有配置设备目录（device.folder）')
      const drafts: MeetingRecordDraft[] = []
      for (const file of await folder.list()) {
        if (seen.has(file.name)) continue
        seen.add(file.name)
        const bytes = await folder.read(file.name)
        if (TEXT_EXT.test(file.name)) {
          const text = new TextDecoder().decode(bytes)
          const transcript = parseTranscript(text)
          if (transcript === undefined) continue
          drafts.push({
            source: 'device',
            transcript,
            bytes,
            mime: file.mime ?? 'text/plain',
            name: file.name,
            consent: { recorded_by: ctx.actor, notice_given: false },
            note: `设备目录导入：${file.name}`,
          })
          continue
        }
        drafts.push({
          source: 'device',
          bytes,
          mime: file.mime ?? 'audio/mpeg',
          name: file.name,
          consent: { recorded_by: ctx.actor, notice_given: false },
          note: `设备目录导入：${file.name}`,
        })
      }
      return drafts
    },
    health() {
      return options.folder === undefined ? { ok: false, detail: '没有配置设备目录' } : { ok: true }
    },
  }
}

/* ------------------------------------------------------------------ */
/* ⑤ third_party：Plaud / Otter / 妙记 的导出                            */
/* ------------------------------------------------------------------ */

export function thirdPartySource(): MeetingRecordSource {
  return {
    id: 'agentsws/third-party-import',
    kind: 'third_party',
    mode: 'manual',
    accept(payload, ctx) {
      const p = payloadOf(payload)
      const text = p.text ?? (p.bytes === undefined ? undefined : new TextDecoder().decode(p.bytes))
      if (text === undefined)
        throw new MeetingError('invalid_input', '第三方导出既没有文本也没有文件内容')
      return textDraft('third_party', text, p, ctx)
    },
  }
}

/* ------------------------------------------------------------------ */
/* ⑥ online_meeting：线上会议平台的导出                                   */
/* ------------------------------------------------------------------ */

/**
 * v1 = 导入平台导出的转写 / 录制文件（飞书 / 腾讯会议 / Zoom / Teams）。
 * **实时 bot 自动入会属付费增强**：接口就在这里（`poll`），免费版不实现，
 * 装了付费应用就是另一个同 `kind` 的 `MeetingRecordSource` 把它顶掉。
 */
export function onlineMeetingSource(): MeetingRecordSource {
  return {
    id: 'agentsws/online-meeting-import',
    kind: 'online_meeting',
    mode: 'manual',
    accept(payload, ctx) {
      const p = payloadOf(payload)
      if (p.text !== undefined) return textDraft('online_meeting', p.text, p, ctx)
      if (p.bytes === undefined)
        throw new MeetingError('invalid_input', '线上会议导出既没有转写也没有录制文件')
      return [
        {
          source: 'online_meeting',
          bytes: p.bytes,
          mime: p.mime ?? 'audio/mp4',
          ...(p.name === undefined ? {} : { name: p.name }),
          consent: consentOf(p, ctx),
          ...common(p),
        },
      ]
    },
    poll() {
      throw new MeetingError(
        'not_implemented',
        '实时入会与自动拉取属付费增强（37 §4.2）；免费版用导入',
      )
    },
  }
}

/* ------------------------------------------------------------------ */
/* 注册表                                                               */
/* ------------------------------------------------------------------ */

export interface MeetingSourceRegistry {
  get(kind: MeetingRecordSource['kind']): MeetingRecordSource
  list(): MeetingRecordSource[]
  /** 同 `kind` 后来者覆盖（23 §2 叠加解析：付费 / 第三方顶掉免费默认版）。 */
  register(source: MeetingRecordSource): void
}

export function createSourceRegistry(
  sources: readonly MeetingRecordSource[] = defaultSources(),
): MeetingSourceRegistry {
  const byKind = new Map<MeetingRecordSource['kind'], MeetingRecordSource>()
  for (const s of sources) byKind.set(s.kind, s)
  return {
    get(kind) {
      const found = byKind.get(kind)
      if (found === undefined)
        throw new MeetingError('not_found', `没有装这种记录来源：${kind}`, { kind })
      return found
    },
    list: () => [...byKind.values()],
    register(source) {
      byKind.set(source.kind, source)
    },
  }
}

/** 内核自带的六个（免费默认层）。 */
export function defaultSources(): MeetingRecordSource[] {
  return [
    handedOverSource(),
    manualNotesSource(),
    inAppRecordingSource(),
    deviceSource(),
    thirdPartySource(),
    onlineMeetingSource(),
  ]
}
