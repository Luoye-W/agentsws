/**
 * WP238（Luoye 10-06 Windows 真机）：职责的权限 / 本体声明翻成人话。
 *
 * 职责页「概览」以前把 yml 原样摊开（`social_account · read / stage · assigned · internal`、
 * `approve_member · staged_change → community_member`、`brand-voice · open · always`）——
 * 那是给开发看的权限声明，不是给运营看的。现在它们收进默认折叠的「高级 · 这条职责能做什么」，
 * 每一行是一句人话（「看社群成员 · 可提议改动」「批入群申请 · 要人批」「技能：品牌话术（常驻）」），
 * **原始 id 只进那一行的 tooltip**（`raw`）。
 *
 * 认不出来的 id 不编：数据域退回原名、动作退回「改 / 对外发 + 对象」的拼法——新职责包里的东西
 * 不会因为少一条译文就从列表上消失。
 */
import { connectionDirectoryEntry } from '@agentsws/contracts'
import type { RoleDetailView } from '@/lib/api'
import { tOr } from '@/lib/humanize'
import type { Lang } from '@/lib/i18n'

type T = (key: string, vars?: Record<string, string | number>) => string

/** 一行：上屏的人话 + tooltip 里的原始声明。 */
export interface CapabilityLine {
  key: string
  text: string
  raw: string
}

/** 数据域 → 人话（没有译文就原名，下划线换空格）。 */
export function domainLabel(t: T, domain: string): string {
  return tOr(t, `duty.domain.${domain}`, domain.replace(/_/g, ' '))
}

/** 能看什么：「看社群成员 · 可提议改动」。 */
export function scopeLines(view: Pick<RoleDetailView, 'scopes'>, t: T): CapabilityLine[] {
  return view.scopes.map((s) => {
    const extra = s.ops
      .filter((op) => op !== 'read')
      .map((op) => tOr(t, `duty.op.${op}`, op))
      .join(' · ')
    const head = t('duty.scope.line', { domain: domainLabel(t, s.domain) })
    return {
      key: `${s.domain}:${s.range}`,
      text: extra === '' ? head : `${head} · ${extra}`,
      raw: `${s.domain} · ${s.ops.join(' / ')} · ${s.range} · ${s.max_sensitivity}`,
    }
  })
}

/** 能做什么：「批入群申请 · 要人批」。要不要人批看这一条的初始自动化档位（没写 = 要人批）。 */
export function actionLines(
  view: Pick<RoleDetailView, 'actions' | 'automation'>,
  t: T,
): CapabilityLine[] {
  return view.actions.map((a) => {
    const generic = t(`duty.kind.${a.kind}`, { target: domainLabel(t, a.target) })
    const fallback = generic === `duty.kind.${a.kind}` ? domainLabel(t, a.target) : generic
    const name = tOr(t, `duty.action.${a.id}`, tOr(t, `org.action.${a.id}`, fallback))
    const level = view.automation.find((x) => x.action_id === a.id)?.initial ?? 'L1'
    return {
      key: a.id,
      text: `${name} · ${tOr(t, `duty.level.${level}`, level)}`,
      raw: `${a.id} · ${a.kind} → ${a.target}`,
    }
  })
}

/** 挂着的技能：「技能：品牌话术（常驻）」。 */
export function skillLines(view: Pick<RoleDetailView, 'skills'>, t: T): CapabilityLine[] {
  return view.skills.map((s) => ({
    key: s.name,
    text: t('duty.skill.line', {
      name: tOr(t, `skill.name.${s.name}`, s.name),
      load: tOr(t, `duty.load.${s.load}`, s.load),
    }),
    raw: `${s.name} · ${s.tier} · ${s.load}`,
  }))
}

/** 要的连接：「Reddit API（可选）」。名字来自连接目录（与连接页同一份）。 */
export function connectorLines(
  view: Pick<RoleDetailView, 'connectors'>,
  t: T,
  lang: Lang,
): CapabilityLine[] {
  return view.connectors.map((c) => {
    const entry = connectionDirectoryEntry(c.kind)
    const name = entry === undefined ? c.kind : lang === 'en' ? entry.name.en : entry.name.zh
    return {
      key: c.kind,
      text: `${name}（${t(c.required ? 'duty.connector.required' : 'duty.connector.optional')}）`,
      raw: `${c.kind} · ${c.required ? 'required' : 'optional'}`,
    }
  })
}
