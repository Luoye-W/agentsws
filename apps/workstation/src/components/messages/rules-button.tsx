/**
 * WP439：消息页右上那一颗「规则」（顶栏右边那排图标里，和岗位页的设置滑杆同一个位置），点了在右栏开规则清单。
 *
 * 也认 `?panel=rules`：铃铛里「X 删了发件人规则」点进来就直接打开（开完把这个参数拿掉，刷新不再弹）。
 * WP441：也认 `?panel=digest`——铃铛里「消息简报：今天 N 封」点进来打开今天的简报。
 */
import { ListChecks } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useRailState } from '@/components/rail/rail-state'
import {
  TOPBAR_ICON,
  TOPBAR_ICON_ACTIVE,
  TOPBAR_ICON_IDLE,
  TopBarAction,
} from '@/components/shell/top-bar-slots'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { MESSAGE_DIGEST_ADDRESS, MESSAGE_RULES_ADDRESS } from './rules-address'

export function MessageRulesButton(): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const [params, setParams] = useSearchParams()
  const panel = params.get('panel')
  const wanted =
    panel === 'rules'
      ? MESSAGE_RULES_ADDRESS
      : panel === 'digest'
        ? MESSAGE_DIGEST_ADDRESS
        : undefined
  const { openAddress } = rail
  useEffect(() => {
    if (wanted === undefined) return
    openAddress(wanted)
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('panel')
        return next
      },
      { replace: true },
    )
  }, [wanted, openAddress, setParams])
  const active = rail.address === MESSAGE_RULES_ADDRESS && rail.open !== null
  return (
    <TopBarAction>
      <button
        type="button"
        data-testid="message-rules-open"
        aria-pressed={active}
        title={t('message_rules.open')}
        className={cn(TOPBAR_ICON, active ? TOPBAR_ICON_ACTIVE : TOPBAR_ICON_IDLE)}
        onClick={() => {
          if (active) rail.show(null)
          else rail.openAddress(MESSAGE_RULES_ADDRESS)
        }}
      >
        <ListChecks aria-hidden className="size-4" />
        <span className="sr-only">{t('message_rules.open')}</span>
      </button>
    </TopBarAction>
  )
}
