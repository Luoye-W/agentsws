/**
 * WP181：右栏「定时任务」——WP140 藏起来的那一格，照官方「自动化任务」的任务页借形做出来。
 *
 * 官方（`@deepseek-ai/dsh-client-ui-schedule`）是：任务列表（名字 + 状态 + 频率 + 下一次）→ 点开看规则，
 * 「Run time」卡里改重复（每周 / 工作日 / 每天 / 一次…）+ 时间 + 周几，改动先攒在本地、有改动才出
 * 「还没保存 · 取消 / 保存」；删之前要确认；页面本身不建任务（建是跟模型说）。**我们照这个形**，
 * 身体用自己的件（`--ws-*` 令牌、少字：说明进 tooltip，不铺步骤）。
 *
 * 数据：`GET /v1/schedules?scope=mine` 里模型用官方工具建的那几条（`automation.reminder`）；
 * 改时间 `PATCH … { rule }`（官方校验、官方算下一次）；暂停 / 恢复 / 删除走原来那几条路由。
 * 在事项页上时，这件事的排在前面。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, Pause, Play, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { StatusPill } from '@/components/design'
import { PanelError } from '@/components/rail/panel-error'
import { parseMatterPath } from '@/components/rail/rail-layout'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { isListedSchedule, SCHEDULES_KEY, scheduleInScope } from '@/components/rail/schedule-count'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  deleteSchedule,
  getMySchedules,
  patchScheduleRule,
  type ScheduledTaskRow,
  toggleSchedule,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { formatDateTime } from '@/lib/format'
import {
  draftOf,
  frequencyText,
  type Repeat,
  type RuleDraft,
  ruleOfTrigger,
  type ScheduleRule,
  sameDraft,
  selectorOfDraft,
} from '@/lib/schedule-rule'

/** WP208：与图标上那个数读同一份缓存（`schedule-count.ts`）。 */
const KEY = SCHEDULES_KEY

export function SchedulesPanel({ pathname, scope }: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const matter_id = parseMatterPath(pathname)
  const list = useQuery({ queryKey: KEY, queryFn: getMySchedules })

  if (list.isPending) return <Skeleton className="h-24 w-full" />
  if (list.error !== null) return <PanelError error={list.error} />

  const rows = list.data.filter(isListedSchedule)
  if (rows.length === 0) {
    return (
      <div className="space-y-1" data-testid="rail-schedules-empty">
        <p className="text-sm">{t('rail.schedules.empty')}</p>
        <p className="text-xs text-muted-foreground">
          {/* WP293：自动化任务跟官方改成内置、一直开，不再提示「先去装官方插件」 */}
          {t('rail.schedules.empty_hint')}
        </p>
      </div>
    )
  }

  // 在事项页上：这件事的排前面；别处（WP208）：当前岗位 / 职责的排前面——与图标上那个数同一个范围
  const here =
    matter_id !== undefined
      ? rows.filter((r) => r.origin?.conversation_id === matter_id)
      : scope === undefined
        ? []
        : rows.filter((r) => scheduleInScope(r, scope))
  const others = rows.filter((r) => !here.includes(r))
  const titled = here.length > 0 && others.length > 0
  return (
    <div className="space-y-4" data-testid="rail-schedules">
      {here.length === 0 ? null : (
        <section className="space-y-2">
          {titled ? (
            <h4 className="text-xs text-muted-foreground">
              {matter_id !== undefined
                ? t('rail.schedules.this_matter')
                : t(`rail.schedules.this_${scope?.tier ?? 'position'}`)}
            </h4>
          ) : null}
          {here.map((row) => (
            <ScheduleRow key={row.id} row={row} />
          ))}
        </section>
      )}
      {others.length === 0 ? null : (
        <section className="space-y-2">
          {titled ? (
            <h4 className="text-xs text-muted-foreground">{t('rail.schedules.others')}</h4>
          ) : null}
          {others.map((row) => (
            <ScheduleRow key={row.id} row={row} />
          ))}
        </section>
      )}
    </div>
  )
}

function ScheduleRow({ row }: { row: ScheduledTaskRow }): ReactNode {
  const { t, lang } = useApp()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const rule = ruleOfTrigger(row.trigger)
  const awaiting = row.params?.awaiting_approval === true
  const paused = row.state === 'paused'
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: KEY })
  }
  const toggle = useMutation({
    mutationFn: () => toggleSchedule(row.id, paused ? 'resume' : 'pause'),
    onSuccess: refresh,
  })
  const remove = useMutation({ mutationFn: () => deleteSchedule(row.id), onSuccess: refresh })
  const title = row.title ?? t('rail.panel.schedules')
  const freq = rule === undefined ? '' : frequencyText(rule, lang)
  return (
    <div
      className="rounded-md border border-[var(--ws-line,var(--border))] p-2"
      data-testid="rail-schedule-row"
      data-state={awaiting ? 'awaiting' : row.state}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-sm"
            title={String(
              (row.params?.official as { prompt?: string } | undefined)?.prompt ?? title,
            )}
          >
            {title}
          </span>
          <span className="block text-xs text-muted-foreground" data-testid="rail-schedule-freq">
            {freq}
            {row.next_fire_at === undefined || awaiting || paused
              ? ''
              : `${freq === '' ? '' : ' · '}${t('rail.schedules.next', { at: formatDateTime(row.next_fire_at, lang) })}`}
          </span>
        </span>
        {awaiting ? (
          <StatusPill tone="warn">{t('rail.schedules.awaiting')}</StatusPill>
        ) : paused ? (
          <StatusPill tone="neutral">{t('schedule.paused')}</StatusPill>
        ) : null}
      </button>
      {!open ? null : (
        <div className="mt-2 space-y-3 border-t pt-2">
          {rule === undefined || rule.kind === 'cron' || rule.kind === 'every' ? (
            <p className="text-xs text-muted-foreground">{t('rail.schedules.readonly')}</p>
          ) : (
            <RuleEditor row={row} rule={rule} onSaved={refresh} />
          )}
          <div className="flex items-center gap-1">
            {awaiting ? null : (
              <Button
                size="xs"
                variant="ghost"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate()}
              >
                {paused ? (
                  <Play className="size-4" aria-hidden />
                ) : (
                  <Pause className="size-4" aria-hidden />
                )}
                {t(paused ? 'schedule.resume' : 'schedule.pause')}
              </Button>
            )}
            {confirming ? (
              <>
                <span className="ml-auto text-xs">{t('rail.schedules.delete_confirm')}</span>
                <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                  {t('action.cancel')}
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={remove.isPending}
                  data-testid="rail-schedule-delete-confirm"
                  onClick={() => remove.mutate()}
                >
                  {t('rail.schedules.delete')}
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                aria-label={t('rail.schedules.delete')}
                onClick={() => setConfirming(true)}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const REPEATS: readonly Repeat[] = ['daily', 'workdays', 'weekly', 'once']
const WEEK_ZH = ['一', '二', '三', '四', '五', '六', '日']
const WEEK_EN = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** 官方「Run time」卡借形：重复 + 时间 + 周几 / 日期；改动攒在本地，有改动才出保存条。 */
function RuleEditor({
  row,
  rule,
  onSaved,
}: {
  row: ScheduledTaskRow
  rule: ScheduleRule
  onSaved(): void
}): ReactNode {
  const { t, lang } = useApp()
  const base = draftOf(rule, row.next_fire_at)
  const [draft, setDraft] = useState<RuleDraft>(base)
  const save = useMutation({
    mutationFn: () => patchScheduleRule(row.id, selectorOfDraft(draft, rule)),
    onSuccess: onSaved,
  })
  const dirty = !sameDraft(draft, base)
  const set = (over: Partial<RuleDraft>): void => {
    setDraft((d) => ({ ...d, ...over }))
  }
  return (
    <div className="space-y-2" data-testid="rail-schedule-editor">
      <div
        className="flex flex-wrap items-center gap-1"
        role="radiogroup"
        aria-label={t('rail.schedules.repeat')}
      >
        {REPEATS.map((r) => (
          <Button
            key={r}
            size="xs"
            variant={draft.repeat === r ? 'secondary' : 'ghost'}
            role="radio"
            aria-checked={draft.repeat === r}
            data-testid={`rail-schedule-repeat-${r}`}
            onClick={() => set({ repeat: r })}
          >
            {t(`rail.schedules.repeat.${r}`)}
          </Button>
        ))}
      </div>
      {draft.repeat !== 'weekly' ? null : (
        <fieldset className="m-0 flex gap-1 border-0 p-0" aria-label={t('rail.schedules.weekdays')}>
          {(lang === 'zh' ? WEEK_ZH : WEEK_EN).map((label, i) => {
            const day = i + 1
            const on = draft.weekdays.includes(day)
            return (
              <Button
                key={day}
                size="icon-xs"
                variant={on ? 'secondary' : 'ghost'}
                aria-pressed={on}
                data-testid={`rail-schedule-day-${day}`}
                onClick={() =>
                  set({
                    weekdays: on
                      ? draft.weekdays.filter((d) => d !== day)
                      : [...draft.weekdays, day],
                  })
                }
              >
                {label}
              </Button>
            )
          })}
        </fieldset>
      )}
      <div className="flex items-center gap-2">
        {draft.repeat !== 'once' ? null : (
          <input
            type="date"
            aria-label={t('rail.schedules.date')}
            className="h-7 rounded-md border bg-background px-2 text-xs"
            value={draft.date}
            onChange={(e) => set({ date: e.target.value })}
          />
        )}
        <input
          type="time"
          aria-label={t('rail.schedules.time')}
          data-testid="rail-schedule-time"
          className="h-7 rounded-md border bg-background px-2 text-xs"
          value={draft.time}
          onChange={(e) => set({ time: e.target.value })}
        />
      </div>
      {save.error === null ? null : (
        <p className="text-xs text-destructive">{apiErrorText(save.error, t)}</p>
      )}
      {!dirty ? null : (
        <div className="flex items-center gap-1" data-testid="rail-schedule-savebar">
          <span className="text-xs text-muted-foreground">{t('rail.schedules.unsaved')}</span>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setDraft(base)}>
            {t('action.cancel')}
          </Button>
          <Button
            size="xs"
            disabled={save.isPending || (draft.repeat === 'weekly' && draft.weekdays.length === 0)}
            data-testid="rail-schedule-save"
            onClick={() => save.mutate()}
          >
            {t('action.save')}
          </Button>
        </div>
      )}
    </div>
  )
}
