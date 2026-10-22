/**
 * WP442（docs/108 §5.3）：规则清单「系统规则」组里那一行——**发出 N 个工作日没回 → 提醒我**。
 *
 * 能改天数（− / +，1–15 个工作日）、能关（开关）、能按邮箱分开设（每只邮箱：跟着上面 / 自己的天数 / 这只不提醒）。
 * 删不掉，只能关。int/1026 合 WP441 后按 `MessageRule.system = 'follow_up'` 并进同一张清单：规则面板「系统规则」
 * 组里和「今天的简报」同一组，那一行就是 {@link FollowUpRuleRow}；{@link FollowUpSystemRule} 是单独成组的外壳。
 *
 * 这台机器没装回信跟进（接口 501）就整组不显示。说明进问号（界面少字）。
 */
import type { MessageFollowUpSettings, MessageFollowUpSettingsPatch } from '@agentsws/contracts'
import { FOLLOW_UP_MAX_BUSINESS_DAYS, FOLLOW_UP_MIN_BUSINESS_DAYS } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Minus, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Hint } from '@/components/ui/hint'
import { Switch } from '@/components/ui/switch'
import { getMessageFollowUpSettings, setMessageFollowUpSettings } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { cn } from '@/lib/utils'

export const FOLLOW_UP_SETTINGS_KEY = ['messages', 'follow-up-settings'] as const

const DAYS = Array.from(
  { length: FOLLOW_UP_MAX_BUSINESS_DAYS - FOLLOW_UP_MIN_BUSINESS_DAYS + 1 },
  (_, i) => FOLLOW_UP_MIN_BUSINESS_DAYS + i,
)

/** 回信跟进的设置（没装回信跟进 = 接口 501 = `data` 一直是 undefined）。 */
export function useFollowUpSettings() {
  return useQuery({
    queryKey: FOLLOW_UP_SETTINGS_KEY,
    queryFn: getMessageFollowUpSettings,
    retry: false,
  })
}

/** 单独成组（「系统规则」标题 + 一行）。规则面板里用 {@link FollowUpRuleRow} 并进同一组。 */
export function FollowUpSystemRule(): ReactNode {
  const { t } = useApp()
  const q = useFollowUpSettings()
  if (q.data === undefined) return null
  return (
    <section
      className="flex flex-col gap-1.5"
      data-testid="message-rules-group"
      data-group="system"
    >
      <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-ws-muted-fg">
        {t('message_rules.group.system')}
        <span className="ws-num">1</span>
      </h3>
      <ul className="flex flex-col divide-y divide-ws-line rounded-[12px] border border-ws-line bg-ws-card">
        <FollowUpRuleRow />
      </ul>
    </section>
  )
}

/** 系统规则「发出 N 个工作日没回 → 提醒我」那一行（`<li>`；没装回信跟进不画）。 */
export function FollowUpRuleRow(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const q = useFollowUpSettings()
  const save = useMutation({
    mutationFn: (patch: MessageFollowUpSettingsPatch) => setMessageFollowUpSettings(patch),
    onSuccess: (s) => {
      client.setQueryData(FOLLOW_UP_SETTINGS_KEY, s)
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['messages'] })
    },
  })
  // 没装回信跟进（501）/ 还在取：整组不画
  if (q.data === undefined) return null
  const s: MessageFollowUpSettings = q.data
  const n = s.business_days
  const busy = save.isPending
  const mailboxes = [...new Set([...(s.mailboxes ?? []), ...s.accounts.map((a) => a.account)])]
  const own = new Map(s.accounts.map((a) => [a.account.toLowerCase(), a]))
  const step = (d: number): void => {
    const next = Math.min(FOLLOW_UP_MAX_BUSINESS_DAYS, Math.max(FOLLOW_UP_MIN_BUSINESS_DAYS, n + d))
    if (next !== n) save.mutate({ business_days: next })
  }
  const stepBtn =
    'inline-flex size-6 items-center justify-center rounded-[6px] border border-ws-line text-ws-muted-fg hover:bg-ws-surface disabled:opacity-50'
  return (
    <li
      className="flex flex-col gap-1.5 px-3 py-2"
      data-testid="follow-up-rule-row"
      data-system="follow_up"
    >
      <div className="flex items-center gap-2">
        <div
          className={cn('min-w-0 flex-1 text-[13px] font-medium', !s.enabled && 'text-ws-muted-fg')}
          data-testid="follow-up-rule-label"
        >
          {t('follow_up.rule.label', { n })}
          <span className="ml-1 inline-flex align-middle">
            <Hint text={t('follow_up.rule.hint')} />
          </span>
        </div>
        <Switch
          checked={s.enabled}
          disabled={busy}
          aria-label={t('follow_up.rule.toggle')}
          data-testid="follow-up-rule-toggle"
          onCheckedChange={(on) => save.mutate({ enabled: on })}
        />
      </div>
      <div className="flex items-center gap-2 text-[12px] text-ws-muted-fg">
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            className={stepBtn}
            aria-label={t('follow_up.rule.less')}
            data-testid="follow-up-rule-less"
            disabled={busy || !s.enabled || n <= FOLLOW_UP_MIN_BUSINESS_DAYS}
            onClick={() => step(-1)}
          >
            <Minus aria-hidden className="size-3" />
          </button>
          <span
            className="ws-num w-5 text-center text-foreground"
            data-testid="follow-up-rule-days"
          >
            {n}
          </span>
          <button
            type="button"
            className={stepBtn}
            aria-label={t('follow_up.rule.more')}
            data-testid="follow-up-rule-more"
            disabled={busy || !s.enabled || n >= FOLLOW_UP_MAX_BUSINESS_DAYS}
            onClick={() => step(1)}
          >
            <Plus aria-hidden className="size-3" />
          </button>
        </span>
        {mailboxes.length === 0 ? null : (
          <button
            type="button"
            aria-expanded={open}
            data-testid="follow-up-rule-per-account"
            className="ml-auto inline-flex items-center gap-0.5 hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
          >
            {t('follow_up.rule.per_account')}
            {s.accounts.length === 0 ? null : <span className="ws-num">· {s.accounts.length}</span>}
            <ChevronDown
              aria-hidden
              className={cn('size-3.5 transition-transform', open && 'rotate-180')}
            />
          </button>
        )}
      </div>
      {open ? (
        <ul className="flex flex-col gap-1" data-testid="follow-up-rule-accounts">
          {mailboxes.map((account) => {
            const row = own.get(account.toLowerCase())
            const value =
              row === undefined
                ? 'same'
                : row.enabled === false
                  ? 'off'
                  : String(row.business_days ?? n)
            return (
              <li key={account} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate" title={account}>
                  {account}
                </span>
                <select
                  aria-label={account}
                  data-testid="follow-up-rule-account"
                  data-account={account}
                  disabled={busy}
                  value={value}
                  className="rounded-[8px] border border-ws-line bg-ws-surface px-1.5 py-0.5 text-[12px]"
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === 'same') save.mutate({ account, reset: true })
                    else if (v === 'off') save.mutate({ account, enabled: false })
                    else save.mutate({ account, enabled: true, business_days: Number(v) })
                  }}
                >
                  <option value="same">{t('follow_up.rule.same')}</option>
                  {DAYS.map((d) => (
                    <option key={d} value={String(d)}>
                      {t('follow_up.rule.own', { n: d })}
                    </option>
                  ))}
                  <option value="off">{t('follow_up.rule.off')}</option>
                </select>
              </li>
            )
          })}
        </ul>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-[12px] text-destructive">
          {t('follow_up.rule.error', { why: apiErrorText(save.error, t) })}
        </p>
      ) : null}
    </li>
  )
}
