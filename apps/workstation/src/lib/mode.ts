/**
 * WP271（docs/95，决策 222）：三种用法——① 个人（默认）/ ② 同事互联 / ③ 公司集体。
 *
 * 工作台只问这一处：`useMode()` 回这家公司现在是哪种用法，并给一个**按模式换词**的 `t`
 * ——先找 `key@solo`（或 `key@peers`），没有再用原来的 `key`。两套词都在
 * `i18n-mode.ts` 里，组件里不写「个人时说 A、公司时说 B」的判断字句。
 *
 * 读不到组织（还在拉、或老服务进程报错）时按 ③ 算：界面与这一版之前一模一样，
 * 宁可多露一眼，也不把公司的东西藏错。服务端没回 `mode`（老进程）就退回看 `solo`。
 */
import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { listOrganizations, type OrganizationView } from './api'
import { useApp } from './app-context'
import { hasKey, translate } from './i18n'

export type UsageMode = 'solo' | 'peers' | 'company'

/** 一家公司的用法：服务端给了 `mode` 就用它；老进程只有 `solo` 就按它推。 */
export function modeOfOrg(org: Pick<OrganizationView, 'solo' | 'mode'>): UsageMode {
  return org.mode ?? (org.solo ? 'solo' : 'company')
}

export interface ModeState {
  mode: UsageMode
  /** ① 个人：公司概念的词一个都不出。 */
  solo: boolean
  /** 组织读到了没有（没读到时 `mode` 是 ③ 的兜底）。 */
  known: boolean
  /** 按模式换词的 `t`：先 `key@{mode}`，再 `key`。 */
  t(key: string, vars?: Record<string, string | number>): string
}

export function useMode(): ModeState {
  const { lang } = useApp()
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => listOrganizations(), retry: false })
  const org = orgs.data?.[0]
  const mode: UsageMode = org === undefined ? 'company' : modeOfOrg(org)
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const variant = `${key}@${mode}`
      return translate(lang, hasKey(lang, variant) ? variant : key, vars)
    },
    [lang, mode],
  )
  return { mode, solo: mode === 'solo', known: org !== undefined, t }
}
