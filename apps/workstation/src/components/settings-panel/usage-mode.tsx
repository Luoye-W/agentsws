/**
 * WP426（Luoye 10-19）：设置 →「个人与团队」——三种用法并排三张可选卡。
 *
 * 原来是一行只读字「使用方式 · 一个人用」，下面一行看不出能点的「和同事一起用 ⓘ」，换模式的入口
 * 藏得最深。现在：
 *
 * - 三张卡：一个人用 / 和同事一起用 / 整个公司用；当前那张标「正在用」，另外两张一个「换成这个」。
 * - 一句话说明进问号；做不到的（没有权限、要先走另一步）按钮置灰，旁边问号说为什么。
 * - **规则一条没改**（docs/95、WP276 / WP277）：
 *   - ① → ②：打开局域网发现、发邀请码（WP276 那一块就地展开）；有同事进来才真的变成 ②；
 *   - → ③：只有发起人（`can_open`），走原来的三步向导；
 *   - ③ → ②：只有老板，走原来的确认框（离职交接没做完时那里不让点）；
 *   - 回到 ①：没有按钮——同事都离开后自动回来（② 里同事可以在「同事」里退出）。
 */
import { Building2, Check, User, Users } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { CloseDialog, CompanyWizard, useCompanySetup } from '@/components/company/company-mode'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { type UsageMode, useMode } from '@/lib/mode'
import { cn } from '@/lib/utils'
import { OrgPage } from '@/pages/org'

const MODES: readonly { mode: UsageMode; icon: typeof User }[] = [
  { mode: 'solo', icon: User },
  { mode: 'peers', icon: Users },
  { mode: 'company', icon: Building2 },
]

/** 一张卡上的动作：能换（点了做什么）/ 换不了（为什么）/ 正在等（① 打开了「一起用」、还没人进来）。 */
type Action =
  | { kind: 'current' }
  | { kind: 'switch'; run: () => void }
  | { kind: 'blocked'; why: string }
  | { kind: 'waiting' }

export function UsageModePicker(): ReactNode {
  const { t } = useApp()
  const { mode, known } = useMode()
  const { orgId, me, assignment, setup } = useCompanySetup()
  /** ① 里点了「和同事一起用」：WP276 那一块就地展开（打开局域网发现、发邀请码）。 */
  const [together, setTogether] = useState(false)
  const [wizard, setWizard] = useState(false)
  const [closing, setClosing] = useState(false)
  if (!known) return null

  const initiator = setup !== undefined && setup.owner_id === me
  const actionOf = (target: UsageMode): Action => {
    if (target === mode) return { kind: 'current' }
    if (target === 'peers') {
      if (mode === 'solo') {
        return together
          ? { kind: 'waiting' }
          : {
              kind: 'switch',
              run: () => {
                setTogether(true)
              },
            }
      }
      // ③ → ②：只有老板（`can_close` 还要看离职交接，那个由确认框自己说）
      return mode === 'company' && initiator
        ? {
            kind: 'switch',
            run: () => {
              setClosing(true)
            },
          }
        : { kind: 'blocked', why: t('mode.why.only_boss') }
    }
    if (target === 'company') {
      return setup?.can_open === true
        ? {
            kind: 'switch',
            run: () => {
              setWizard(true)
            },
          }
        : { kind: 'blocked', why: t('mode.why.only_initiator') }
    }
    // 回到 ①：没有按钮，说清楚怎么回去
    if (mode === 'company') return { kind: 'blocked', why: t('mode.why.solo_from_company') }
    return {
      kind: 'blocked',
      why: initiator ? t('mode.why.solo_from_peers') : t('mode.why.solo_leave'),
    }
  }

  return (
    <div className="flex flex-col gap-4 py-3" data-testid="settings-usage-mode" data-mode={mode}>
      <ul className="grid gap-3 sm:grid-cols-3" aria-label={t('sp.mode')} data-testid="mode-cards">
        {MODES.map(({ mode: m, icon: Icon }) => {
          const action = actionOf(m)
          const current = action.kind === 'current'
          return (
            <li
              key={m}
              {...(current ? { 'aria-current': 'true' as const } : {})}
              data-testid="mode-card"
              data-mode={m}
              data-current={current}
              className={cn(
                // WP456-T6（§2.5「卡不加边框」）：无边框 + 卡阴影；选中的那张品牌浅底 + 一圈品牌色
                'flex min-h-36 flex-col justify-between gap-4 rounded-xl p-4 transition-colors',
                current ? 'bg-ws-brand-soft/30 ring-1 ring-ws-brand/40' : 'bg-ws-card shadow-ws',
              )}
            >
              <div className="flex flex-col gap-3">
                <span
                  className={cn(
                    'inline-flex size-9 items-center justify-center rounded-lg',
                    current ? 'bg-ws-brand text-ws-brand-fg' : 'bg-ws-surface text-ws-body',
                  )}
                >
                  <Icon aria-hidden className="size-4.5" />
                </span>
                <span className="flex items-center gap-1 text-sm font-medium text-ws-ink">
                  {t(`sp.mode.${m}`)}
                  <Hint text={t(`mode.card.${m}.hint`)} testId="mode-card-hint" />
                </span>
              </div>
              <ModeAction action={action} />
            </li>
          )
        })}
      </ul>

      {/* ① → ②：WP276 那一块（打开局域网发现、邀请码、同事的申请）就地展开 */}
      {mode === 'solo' && together ? <OrgPage only="together" autoStart /> : null}

      {setup === undefined || orgId === undefined ? null : (
        <>
          {setup.can_open ? (
            <CompanyWizard
              open={wizard}
              onOpenChange={setWizard}
              orgId={orgId}
              setup={setup}
              {...(me === undefined ? {} : { me })}
              {...(assignment === undefined ? {} : { assignment })}
            />
          ) : null}
          {mode === 'company' && initiator ? (
            <CloseDialog
              open={closing}
              onOpenChange={setClosing}
              orgId={orgId}
              setup={setup}
              {...(assignment === undefined ? {} : { assignment })}
            />
          ) : null}
        </>
      )}
    </div>
  )
}

function ModeAction({ action }: { action: Action }): ReactNode {
  const { t } = useApp()
  switch (action.kind) {
    case 'current':
      return (
        <span
          className="inline-flex w-fit items-center gap-1 rounded-full bg-ws-brand px-2.5 py-0.5 text-xs font-medium text-ws-brand-fg"
          data-testid="mode-current"
        >
          <Check aria-hidden className="size-3" strokeWidth={3} />
          {t('mode.current')}
        </span>
      )
    case 'waiting':
      return (
        <span
          className="inline-flex w-fit items-center gap-1.5 text-xs text-ws-muted-fg"
          data-testid="mode-waiting"
        >
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-ws-info" />
          {t('mode.waiting')}
        </span>
      )
    case 'switch':
      return (
        <Button
          size="sm"
          variant="secondary"
          className="w-fit"
          data-testid="mode-switch"
          onClick={action.run}
        >
          {t('mode.switch')}
        </Button>
      )
    case 'blocked':
      return (
        <span className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            className="w-fit"
            disabled
            data-testid="mode-switch"
          >
            {t('mode.switch')}
          </Button>
          <Hint text={action.why} testId="mode-why" />
        </span>
      )
  }
}
