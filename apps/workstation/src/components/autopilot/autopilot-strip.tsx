/**
 * WP428（决策 1244 改）：「全自动」那一条（通用积木的界面这一半）。
 *
 * 只在有话说的时候出：开着（「全自动 · 开着」+ 关掉）或者够条件了还没开（「够条件了」+ 开全自动）。
 * 别的时候一个字都不出（界面少字）。凭什么 / 开了能多做什么 / 什么不变，进问号。
 * 建议卡（「这类可以交给 AI 全自动了」）在「要你处理」里，这一条是它的常驻开关。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { type AutopilotScopeView, getAutopilot, setAutopilot } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'

export function AutopilotStrip({ assignment }: { assignment: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const status = useQuery({
    queryKey: ['autopilot', assignment],
    queryFn: () => getAutopilot(assignment),
    retry: false,
  })
  const toggle = useMutation({
    mutationFn: (input: { scope: AutopilotScopeView; on: boolean }) =>
      setAutopilot(input.scope.scope_id, input.on, assignment),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['autopilot', assignment] })
    },
  })
  const rows = (status.data ?? []).filter((s) => s.on || s.eligible)
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col gap-1" data-testid="autopilot-strip">
      {rows.map((s) => (
        <div
          key={s.scope_id}
          className="flex flex-wrap items-center gap-2 rounded-lg bg-ws-surface px-3 py-1.5 text-[13px]"
          data-testid="autopilot-row"
          data-on={s.on ? 'true' : 'false'}
        >
          <span className="font-medium">
            {s.on
              ? t('autopilot.on', { title: s.title })
              : t('autopilot.ready', { title: s.title })}
          </span>
          <Hint text={`${s.on ? '' : `${s.why}。`}${s.grants}；${s.keeps}。`} />
          <Button
            size="xs"
            variant={s.on ? 'ghost' : 'secondary'}
            className="ml-auto"
            data-testid="autopilot-toggle"
            disabled={toggle.isPending}
            onClick={() => {
              toggle.mutate({ scope: s, on: !s.on })
            }}
          >
            {s.on ? t('autopilot.turn_off') : t('autopilot.turn_on')}
          </Button>
          {toggle.error === null ? null : (
            <span role="alert" className="w-full text-xs text-destructive">
              {apiErrorText(toggle.error, t)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
