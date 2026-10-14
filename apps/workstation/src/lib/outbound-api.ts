/**
 * WP323（docs/102 §5）：发出记录与记录去处的接口（`/v1/outbound/*`）。
 *
 * 单独一个文件（`api.ts` 那张大表好几单同时在加），形状直接用契约里那几个类型。
 * 去处的**新建与改不在这里**：用户在岗位里用说话交代，AI 出「定规矩」卡，卡在卡片流里决定。
 */
import type { OutboundRecord, OutboundStatus, RecordSinkView } from '@agentsws/contracts'
import { api } from './api'

export type { OutboundRecord, RecordSinkView } from '@agentsws/contracts'

export const OUTBOUND_KEY = ['outbound', 'records'] as const
export const SINKS_KEY = ['outbound', 'sinks'] as const

export interface OutboundFilter {
  channel?: string
  status?: OutboundStatus
}

const qs = (f: OutboundFilter & { format?: string }): string => {
  const p = new URLSearchParams()
  if (f.format !== undefined) p.set('format', f.format)
  if (f.channel !== undefined && f.channel !== '') p.set('channel', f.channel)
  if (f.status !== undefined) p.set('status', f.status)
  const s = p.toString()
  return s === '' ? '' : `?${s}`
}

export const listOutbound = (f: OutboundFilter = {}): Promise<OutboundRecord[]> =>
  api(`/v1/outbound/records${qs(f)}`)

export const exportOutbound = (
  format: 'csv' | 'json',
  f: OutboundFilter = {},
): Promise<{ filename: string; content: string; count: number }> =>
  api(`/v1/outbound/records/export${qs({ ...f, format })}`)

export const listSinks = (): Promise<RecordSinkView[]> => api('/v1/outbound/sinks')

export const sinkAction = (id: string, verb: 'pause' | 'resume' | 'retry'): Promise<unknown> =>
  api(`/v1/outbound/sinks/${encodeURIComponent(id)}/${verb}`, { method: 'POST' })

export const removeSink = (id: string): Promise<{ removed: true }> =>
  api(`/v1/outbound/sinks/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** 浏览器里把导出的那份存成文件（不经服务端写盘）。 */
export function saveText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
