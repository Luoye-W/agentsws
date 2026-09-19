/**
 * 「复制一行」与「下载 CSV」（WP119 定论 2：**不登录也能用的本地档**）。
 *
 * 这是插件的保底出口：桌面应用没装、本机服务没起、云也没登——用户仍然能在
 * 页面上按一下，把这个人粘进自己的飞书表。一个功能如果只在"一切都配好了"
 * 的时候才有用，那它在用户第一次打开的那五分钟里就是没用的。
 *
 * 两条格式纪律：
 *
 * 1. **新列只能加在末尾**。下游（飞书多维表、Excel 模板）按位置映射，
 *    往中间插一列等于把所有人的表错一格。
 * 2. **CSV 带 BOM**。不带的话 Excel 打开中文就是乱码，而用户会认为是插件坏了。
 */

import type { CreatorHealth } from './health.js'
import { formatRatioPercent } from './health.js'
import type { CreatorSnapshot, Platform } from './snapshot.js'
import { PLATFORM_NAMES } from './snapshot.js'

/** 一行里不能有制表符与换行——有就会把一行撑成两行。 */
const flatten = (value: string): string => value.replace(/[\t\n\r]+/g, ' ')

/** 数字列：`undefined` 是空格，不是 0。 */
const raw = (value: number | undefined): string =>
  value === undefined || !Number.isFinite(value) ? '' : String(Math.round(value))

function csvEscape(value: string): string {
  return /["',\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export interface CreatorExportTable {
  header: string[]
  row: string[]
}

/**
 * 三个平台三套列（页面上答得出的东西本来就不一样，强行统一只会多出一堆空列）。
 *
 * `contact` 是用户在卡片上手填 / 手动收下的那个邮箱——**优先于**页面上读到的，
 * 因为用户改过就是用户说了算。
 */
export function creatorExportTable(
  snapshot: CreatorSnapshot,
  health: CreatorHealth,
  options: { contact?: string | undefined } = {},
): CreatorExportTable {
  const contact = options.contact ?? snapshot.business_email ?? ''
  const platform = PLATFORM_NAMES[snapshot.platform]
  const captured = snapshot.observed_at
  const links = String(snapshot.links.length)
  const cross = crossPlatformCell(snapshot)

  if (snapshot.platform === 'youtube') {
    return {
      header: [
        '平台',
        '名称',
        'Handle',
        '频道ID',
        '主页链接',
        '订阅数',
        '视频总数',
        '总播放量',
        '平均播放',
        '播放/订阅比',
        '疑似刷粉',
        '地区',
        '注册时间',
        '商务邮箱',
        '简介',
        '外链数',
        '其他平台主页',
        '采集时间',
      ],
      row: [
        platform,
        snapshot.name,
        snapshot.handle ?? '',
        snapshot.external_id,
        snapshot.page_url,
        raw(snapshot.followers),
        raw(snapshot.video_count),
        raw(snapshot.total_views),
        raw(health.avg_views),
        formatRatioPercent(health.views_to_followers),
        health.bought_audience_suspected ? '是' : '否',
        snapshot.country ?? '',
        snapshot.joined_date ?? '',
        contact,
        snapshot.bio ?? '',
        links,
        cross,
        captured,
      ].map(flatten),
    }
  }

  if (snapshot.platform === 'instagram') {
    return {
      header: [
        '平台',
        '名称',
        'Handle',
        '账号ID',
        '主页链接',
        '粉丝数',
        '帖子总数',
        '近期帖子数',
        '平均播放',
        '商务邮箱',
        '简介',
        '外链数',
        '其他平台主页',
        '采集时间',
      ],
      row: [
        platform,
        snapshot.name,
        snapshot.handle ?? '',
        snapshot.external_id,
        snapshot.page_url,
        raw(snapshot.followers),
        raw(snapshot.video_count),
        String(snapshot.recent_items.length),
        raw(health.avg_views),
        contact,
        snapshot.bio ?? '',
        links,
        cross,
        captured,
      ].map(flatten),
    }
  }

  return {
    header: [
      '平台',
      '名称',
      'Handle',
      '账号ID',
      '主页链接',
      '粉丝数',
      '视频总数',
      '近期视频数',
      '平均播放',
      '播放/粉丝比',
      '疑似刷粉',
      '地区',
      '商务邮箱',
      '简介',
      '外链数',
      '其他平台主页',
      '采集时间',
    ],
    row: [
      platform,
      snapshot.name,
      snapshot.handle ?? '',
      snapshot.external_id,
      snapshot.page_url,
      raw(snapshot.followers),
      raw(snapshot.video_count),
      String(snapshot.recent_items.length),
      raw(health.avg_views),
      formatRatioPercent(health.views_to_followers),
      health.bought_audience_suspected ? '是' : '否',
      snapshot.country ?? '',
      contact,
      snapshot.bio ?? '',
      links,
      cross,
      captured,
    ].map(flatten),
  }
}

/** 识别外链里的其它平台主页。顺序即优先级。 */
const SOCIAL_HOSTS: { platform: string; pattern: RegExp }[] = [
  { platform: 'YouTube', pattern: /youtube\.com\//i },
  { platform: 'Instagram', pattern: /instagram\.com\//i },
  { platform: 'TikTok', pattern: /tiktok\.com\/@/i },
  { platform: 'X', pattern: /(?:twitter|x)\.com\//i },
  { platform: 'Twitch', pattern: /twitch\.tv\//i },
  { platform: 'Facebook', pattern: /facebook\.com\//i },
  { platform: 'LinkedIn', pattern: /linkedin\.com\/(in|company)\//i },
]

const SELF_PLATFORM: Record<Platform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
}

/** `YouTube: url | X: url`。每个平台只留第一个，跳过指回自己的那条。 */
export function crossPlatformCell(snapshot: CreatorSnapshot): string {
  const self = SELF_PLATFORM[snapshot.platform]
  const seen = new Map<string, string>()
  for (const href of snapshot.links) {
    const hit = SOCIAL_HOSTS.find((s) => s.pattern.test(href))
    if (hit === undefined) continue
    if (hit.platform === self) continue
    if (seen.has(hit.platform)) continue
    seen.set(hit.platform, href)
  }
  return [...seen.entries()].map(([name, href]) => `${name}: ${href}`).join(' | ')
}

/** 一行 TSV：直接粘进飞书 / Excel 就是一行。 */
export function toTsvRow(values: readonly string[]): string {
  return values.map((v) => flatten(v)).join('\t')
}

/** 带 BOM 的 CSV（表头 + 若干行）。 */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((r) => r.map((v) => csvEscape(flatten(v))).join(','))
  return `﻿${lines.join('\n')}\n`
}

/** `红人助手-tseries-2026-09-19.csv`。 */
export function exportFileName(basename: string, today: string): string {
  const safe = basename.replace(/[^\w@.-]+/g, '-').replace(/^-+|-+$/g, '') || 'export'
  return `红人助手-${safe}-${today.slice(0, 10)}.csv`
}
