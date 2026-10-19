/**
 * WP429：设置 → 通知「通知方式」——每类一行，「站内」「系统」各一列开关。
 *
 * 站内 = 进右上角铃铛；系统 = 同时弹系统通知（桌面版）。站内关了，系统那一格也关、点不动。
 * 每类是什么只进问号（界面少字）。
 */
import { NOTIFICATION_CATEGORIES } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Switch } from '@/components/ui/switch'
import {
  getNotificationPrefs,
  NOTIFICATION_PREFS_KEY,
  type NotificationCategory,
  type NotificationPrefs,
  putNotificationPrefs,
} from '@/lib/api-notifications'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { CATEGORY_LOOK } from './notification-bell'

type Col = 'inbox' | 'system'

export function NotificationPrefsCard(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const prefs = useQuery({
    queryKey: NOTIFICATION_PREFS_KEY,
    queryFn: getNotificationPrefs,
    retry: false,
  })
  const save = useMutation({
    mutationFn: (input: { cat: NotificationCategory; col: Col; on: boolean }) =>
      putNotificationPrefs({ [input.cat]: { [input.col]: input.on } }),
    // 先改界面再等回话（开关要跟手）
    onMutate: (input) => {
      const prev = client.getQueryData<NotificationPrefs>(NOTIFICATION_PREFS_KEY)
      if (prev !== undefined) {
        const row = { ...prev[input.cat], [input.col]: input.on }
        if (input.col === 'inbox' && !input.on) row.system = false
        client.setQueryData(NOTIFICATION_PREFS_KEY, { ...prev, [input.cat]: row })
      }
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev !== undefined) client.setQueryData(NOTIFICATION_PREFS_KEY, ctx.prev)
    },
    onSuccess: (next) => {
      client.setQueryData(NOTIFICATION_PREFS_KEY, next)
    },
  })
  const data = prefs.data
  if (data === undefined) return null
  return (
    <Card data-testid="settings-notify-prefs">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <BellRing aria-hidden className="size-4" />
          {t('notify.prefs.title')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full max-w-md text-sm">
          <thead>
            <tr>
              <th className="sr-only">{t('notify.title')}</th>
              {(['inbox', 'system'] as const).map((col) => (
                <th
                  key={col}
                  scope="col"
                  title={t(`notify.col.${col}.hint`)}
                  className="w-14 pb-1 text-center text-xs font-normal text-ws-muted-fg"
                >
                  {t(`notify.col.${col}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_CATEGORIES.map((cat) => {
              const look = CATEGORY_LOOK[cat]
              const Icon = look.icon
              const row = data[cat]
              return (
                <tr key={cat} data-testid={`notify-pref-${cat}`}>
                  <th scope="row" className="py-1.5 text-left font-normal">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          'flex size-6 shrink-0 items-center justify-center rounded-full',
                          look.tone,
                        )}
                      >
                        <Icon aria-hidden className="size-3.5" />
                      </span>
                      <span className="truncate">{t(`notify.cat.${cat}`)}</span>
                      <Hint text={t(`notify.cat.${cat}.hint`)} />
                    </span>
                  </th>
                  {(['inbox', 'system'] as const).map((col) => (
                    <td key={col} className="text-center">
                      <Switch
                        checked={row[col]}
                        disabled={col === 'system' && !row.inbox}
                        aria-label={t('notify.prefs.toggle', {
                          cat: t(`notify.cat.${cat}`),
                          col: t(`notify.col.${col}`),
                        })}
                        data-testid={`notify-pref-${cat}-${col}`}
                        onCheckedChange={(on) => {
                          save.mutate({ cat, col, on })
                        }}
                      />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
