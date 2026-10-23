/**
 * WP447（docs/109 §6.2 拿数第 ① 条路）：用户把平台导出的报表**拖进对话**——投放岗位页、六条新职责的页、
 * 投放的事项里都算——认得出是六个新平台之一的，直接进看数据的库，并在那份附件的文字前面写一句
 * 「已入库：…（几行、哪几天、币种、时区）」，AI 读到就知道数已经在库里、该用 `read_ads_export` 看。
 *
 * 不出声的情况：不在投放岗位 / 投放职责里、扩展名不像报表、认不出是这六家里的哪一家（Google / Meta 的表
 * 交回原来那条路：附件照常读成文字给 AI）。在某一条新平台职责里拖进来却认不出的，照实说一句为什么没入库。
 * 这一家的职责没人担（岗位设定里没勾）：不入库，说一句去勾。
 */
import { type ExportPlatform, isExportPlatform } from '@agentsws/ads-core'
import { adsPlatformOfRole } from '@agentsws/contracts'
import { exportPlatformLabel, looksLikeAdsExport, parseExportFile } from './export-ingest.js'
import type { AdsDataService } from './service.js'

export interface AdsExportIntakeContext {
  /** 这句话落在哪条职责上（定了的话）。 */
  role_id?: string
  /** 从哪个岗位开的（`ads` = 投放）。 */
  position_template_id?: string
  /** WP489：谁拖进来的（红人表出预览卡要知道卡给谁）。 */
  person_id?: string
}

/** 每份附件一句（不相干的回 `undefined`）。 */
export type AdsExportIntake = (
  files: readonly { name: string; data: string }[],
  ctx: AdsExportIntakeContext,
) => (string | undefined)[]

export function createAdsExportIntake(options: {
  service(): AdsDataService | undefined
  /** 这一家的职责有没有人担着。 */
  held(platform: ExportPlatform): boolean
  now(): string
  tzOffsetMinutes(): number
}): AdsExportIntake {
  return (files, ctx) => {
    const pinned = ctx.role_id === undefined ? undefined : adsPlatformOfRole(ctx.role_id)?.id
    const inAds = ctx.position_template_id === 'ads' || pinned !== undefined
    if (!inAds) return files.map(() => undefined)
    const platform = pinned !== undefined && isExportPlatform(pinned) ? pinned : undefined
    const svc = options.service()
    return files.map((f) => {
      if (svc === undefined || !looksLikeAdsExport(f.name)) return undefined
      const bytes = new Uint8Array(Buffer.from(f.data, 'base64'))
      // 先认一遍（纯函数，不入库）：是不是这六家之一、这一家有没有人担
      const probe = parseExportFile({
        id: 'probe',
        bytes,
        name: f.name,
        ...(platform === undefined ? {} : { platform }),
        source: 'manual',
        at: options.now(),
        tzOffsetMinutes: options.tzOffsetMinutes(),
      })
      if (!probe.ok) return platform === undefined ? undefined : `没入库：${probe.message}`
      if (!options.held(probe.platform))
        return `这是${exportPlatformLabel(probe.platform)}的报表，但投放岗位里还没勾这条职责，没入库——在岗位设定里勾上它再拖一次。`
      const out = svc.importExport({
        bytes,
        name: f.name,
        platform: probe.platform,
        source: 'manual',
      })
      return out.ok
        ? `${out.note}（用 read_ads_export 看、run_ads_audit 体检）`
        : `没入库：${out.message}`
    })
  }
}

/** 把那一句写在附件文字前面（AI 先读到它）。 */
export function withIntakeNote<T extends { chars: number; text?: string }>(
  attachment: T,
  note: string | undefined,
): T {
  if (note === undefined) return attachment
  const text =
    attachment.text === undefined || attachment.text === '' ? note : `${note}\n\n${attachment.text}`
  return { ...attachment, text, chars: text.length }
}

/** WP489：几个入库口子拼成一个——每份附件取第一个认领它的那一句。 */
export function composeIntakes(
  ...list: (AdsExportIntake | undefined)[]
): AdsExportIntake | undefined {
  const live = list.filter((x): x is AdsExportIntake => x !== undefined)
  if (live.length === 0) return undefined
  if (live.length === 1) return live[0]
  return (files, ctx) => {
    const notes = live.map((f) => f(files, ctx))
    return files.map((_, i) => notes.map((n) => n[i]).find((x) => x !== undefined))
  }
}
