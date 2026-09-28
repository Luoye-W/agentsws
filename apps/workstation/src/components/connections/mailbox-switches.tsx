/**
 * WP167：连接页那只邮箱卡上的开关——判成客服的信在邮箱里怎么动。
 *
 * 老产品 KefuAgent 的四个开关：影子模式 / 挪信 / 标已读三个在这里拨；第四个「接管」就是
 * 这个品牌开没开客服岗位（岗位页的事），这里只读、画成一个小标。
 *
 * 36 §7 少字：卡上只有开关与一句话，解释全进问号。影子模式开着时卡上醒目标「只看不动」——
 * 那是"Agent 在处理，但你的邮箱一下都没动"，人得一眼看出来，不然会以为挪信坏了。
 *
 * 不是邮箱、或这台机器没装消息同步（接口回 404）：什么都不画。
 *
 * WP172：B2B 岗位开着时多一个「收 B2B 信」（判成 B2B 的挪进 `BtoBAgents`，缺省开）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EyeOff } from 'lucide-react'
import { Hint } from '@/components/ui/hint'
import { Switch } from '@/components/ui/switch'
import {
  getMailboxSwitches,
  type MailboxSwitchesView,
  type MailboxSwitchName,
  setMailboxSwitches,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

const SWITCHES: readonly MailboxSwitchName[] = ['shadow_mode', 'move', 'mark_read']
/** WP172：B2B 岗位开着才画这一格（没开时它不起作用，画出来只会让人困惑）。 */
const B2B_SWITCHES: readonly MailboxSwitchName[] = [...SWITCHES, 'b2b']

export function MailboxSwitches({
  connectionId,
  assignment,
}: {
  connectionId: string
  assignment?: string | undefined
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const key = ['mailbox-switches', connectionId, assignment ?? '']
  const view = useQuery({
    queryKey: key,
    queryFn: () => getMailboxSwitches(connectionId, assignment),
    retry: false,
  })
  const flip = useMutation({
    mutationFn: (input: { name: MailboxSwitchName; on: boolean }) =>
      setMailboxSwitches(connectionId, { [input.name]: input.on }, assignment),
    onSuccess: (next: MailboxSwitchesView) => {
      client.setQueryData(key, next)
    },
  })
  const data = view.data
  if (data === undefined) return null
  const shadow = data.shadow_mode

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-md border px-2 py-1.5',
        shadow ? 'border-amber-500/50 bg-amber-500/5' : 'border-ws-line',
      )}
      data-testid="mailbox-switches"
      data-shadow={shadow ? 'true' : undefined}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium" data-slot="title">
          {t('connections.mailbox.title')}
        </span>
        <Hint text={t('connections.mailbox.title.hint')} />
        <span
          className={cn(
            'rounded-full px-1.5 py-px text-[11px]',
            data.takeover ? 'bg-ws-tint text-ws-brand-ink' : 'bg-muted text-muted-foreground',
          )}
          data-slot="badge"
          data-testid="mailbox-takeover"
          data-on={data.takeover ? 'true' : 'false'}
        >
          {t(
            data.takeover ? 'connections.mailbox.takeover.on' : 'connections.mailbox.takeover.off',
          )}
        </span>
        <Hint text={t('connections.mailbox.takeover.hint')} />
        {shadow ? (
          <strong
            className="ml-auto flex items-center gap-1 text-[12px] font-semibold text-amber-700 dark:text-amber-400"
            data-slot="status"
            data-testid="mailbox-shadow-badge"
          >
            <EyeOff aria-hidden className="size-3.5" />
            {t('connections.mailbox.shadow.on')}
          </strong>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {(data.b2b_position === true ? B2B_SWITCHES : SWITCHES).map((name) => (
          <li key={name} className="flex items-center gap-1.5 text-xs">
            <Switch
              size="sm"
              id={`mailbox-${connectionId}-${name}`}
              checked={data[name] ?? true}
              disabled={flip.isPending}
              aria-label={t(`connections.mailbox.${name}`)}
              data-testid={`mailbox-switch-${name}`}
              onCheckedChange={(on) => {
                flip.mutate({ name, on })
              }}
            />
            <label
              htmlFor={`mailbox-${connectionId}-${name}`}
              className={cn(shadow && name !== 'shadow_mode' && 'text-muted-foreground')}
            >
              {t(`connections.mailbox.${name}`)}
            </label>
            <Hint text={t(`connections.mailbox.${name}.hint`)} />
          </li>
        ))}
      </ul>
      {flip.error === null ? null : (
        <p role="alert" className="text-[11px] text-destructive">
          {t('connections.mailbox.failed')}
        </p>
      )}
    </div>
  )
}
