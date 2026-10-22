/**
 * WP324（决策 690）：**连接卡**的身体——要连哪几样（每样一行：标志 + 名字 + 绿勾 / 接法），一句为什么，
 * 花钱 / 能动东西的再加一行风险。卡片流、事项时间线、第三栏都是这一块。
 *
 * 出现规则（docs/96 P3）：
 * - 出：一件事跑到一半撞上缺连接（服务端出卡）；或人在数据看板 / 岗位页点「去连接」（第三栏开，不带事项）；
 * - 不出：都连上了（那一样画一个绿勾，全绿就收起、接着做）；同一缺项已经有一张在等（服务端不重复出）。
 *
 * 全都连上了 → 叫 `onAllConnected` 一次（卡片流 / 时间线里那张由它点「接着做」，原任务自动接着跑）。
 * 有查不了连没连上的（认不出的接法）→ 出一个「连好了，接着做」让人自己说。
 */
import type { ConnectNeed } from '@agentsws/contracts'
import { CheckCircle2, CircleDashed, ShieldAlert } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { BrandIcon } from '@/components/brand-icons'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'
import { type ConnectContext, ConnectWidget, useNeedConnected } from './connect-widgets'
import { useConnectAssignment, useConnectionState } from './use-connect-flow'

/** 卡上要用的连接上下文（连接是所有者的事）。 */
export function useConnectContext(
  duty: { role_id: string; assignment_id: string } | undefined,
): ConnectContext {
  const { assignment } = useConnectAssignment()
  const state = useConnectionState(assignment)
  return { owner: assignment, duty, ...state }
}

function NeedRow({
  need,
  ctx,
  onState,
}: {
  need: ConnectNeed
  ctx: ConnectContext
  onState: (kind: string, connected: boolean | undefined) => void
}): ReactNode {
  const { t } = useApp()
  const connected = useNeedConnected(need, ctx)
  useEffect(() => {
    onState(need.kind, connected)
  }, [need.kind, connected, onState])
  const done = connected === true && need.state !== 'reauth'
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-ws-line bg-ws-card p-2.5"
      data-testid="setup-need"
      data-service={need.service ?? ''}
      data-connected={connected === undefined ? 'unknown' : String(connected)}
    >
      <div className="flex items-center gap-2 text-sm text-ws-ink">
        <BrandIcon provider={need.service ?? need.kind} />
        <span className="font-medium">{need.name}</span>
        {need.state === 'reauth' ? (
          <span className="text-xs text-ws-warn">{t('setup.connect.reauth')}</span>
        ) : null}
        <span className="ml-auto">
          {done ? (
            <CheckCircle2 className="size-4 text-ws-good" aria-label={t('setup.connect.done')} />
          ) : (
            <CircleDashed className="size-4 text-ws-muted-fg" aria-hidden />
          )}
        </span>
      </div>
      {done ? null : <ConnectWidget need={need} ctx={ctx} />}
    </li>
  )
}

export function ConnectNeedsBody({
  needs,
  why,
  risk,
  ctx,
  onAllConnected,
  onContinue,
  continuing = false,
}: {
  needs: readonly ConnectNeed[]
  why?: string | undefined
  risk?: string | undefined
  ctx: ConnectContext
  /** 全都（查得到的）连上了：叫一次。 */
  onAllConnected?: () => void
  /** 有查不了的：人点「连好了，接着做」。不给就不出这个按钮（第三栏单独开时）。 */
  onContinue?: () => void
  continuing?: boolean
}): ReactNode {
  const { t } = useApp()
  const [states, setStates] = useState<Record<string, boolean | undefined>>({})
  const fired = useRef(false)
  const onState = useCallback((kind: string, connected: boolean | undefined): void => {
    setStates((prev) =>
      prev[kind] === connected && kind in prev ? prev : { ...prev, [kind]: connected },
    )
  }, [])
  const all = needs.every((n) => states[n.kind] === true && n.state !== 'reauth')
  useEffect(() => {
    if (!all || fired.current || onAllConnected === undefined) return
    fired.current = true
    onAllConnected()
  }, [all, onAllConnected])
  // 有查不了的（认不出的接法 / 要重新授权的）：让人自己说「连好了」
  const unknown = needs.some((n) => states[n.kind] === undefined || n.state === 'reauth')
  return (
    <div className="flex flex-col gap-2" data-testid="setup-connect">
      {why === undefined || why === '' ? null : (
        <p className="text-sm leading-6 text-ws-body">{why}</p>
      )}
      {risk === undefined ? null : (
        <p
          className="flex items-start gap-1.5 rounded-md bg-ws-warn-bg px-2 py-1.5 text-xs text-ws-warn"
          data-testid="setup-connect-risk"
        >
          <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {risk}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {needs.map((n) => (
          <NeedRow key={n.kind} need={n} ctx={ctx} onState={onState} />
        ))}
      </ul>
      {onContinue === undefined || !unknown ? null : (
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={continuing}
            data-testid="setup-connect-continue"
            onClick={onContinue}
          >
            {t('setup.connect.continue')}
          </Button>
        </div>
      )}
    </div>
  )
}
