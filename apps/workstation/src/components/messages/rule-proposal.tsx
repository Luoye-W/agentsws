/**
 * WP441（docs/108 §5.1.2）：「要建这条规则吗」——一句话转出来的规则草案，规则面板顶上和卡片流里同一个样子。
 *
 * 从上到下：名字 + 一行白话；试跑（过去 30 天会命中几封、前 5 封）；**会被改掉去向的那几封**（最容易出事的地方，
 * 单列）；用工坊积分时花了多少；一个勾「也处理过去 30 天的」（默认不勾）；按钮「建 / 修改 / 不要」。
 * 建 = 拍板：只有点了才生效。少字：说明进问号。
 */
import type { MessagePositionOption, MessageRuleTrial } from '@agentsws/contracts'
import { ArrowRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { positionName } from '@/components/messages/hand-actions'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'

/** 「原来归哪 / 会归哪」那一格的人话。 */
export function destinationLabel(
  t: (key: string, vars?: Record<string, string | number>) => string,
  positions: readonly MessagePositionOption[] | undefined,
  lang: string,
  id: string,
): string {
  if (id === 'notice') return t('message_rules.dest.notice')
  if (id === 'unclaimed') return t('message_rules.dest.unclaimed')
  if (id === 'me') return t('message_rules.dest.me')
  return positionName(positions, id, lang)
}

export function RuleProposalView({
  name,
  plain,
  trial,
  editing,
  positions,
  busy,
  decided,
  onBuild,
  onEdit,
  onDrop,
  testId = 'rule-proposal',
}: {
  name: string
  plain: string
  trial: MessageRuleTrial
  /** 改一条已有的规则（按钮写「改」）。 */
  editing?: boolean
  positions?: readonly MessagePositionOption[] | undefined
  busy?: boolean
  /** 已经定了（建了 / 不要了）：只读，不出按钮。 */
  decided?: 'built' | 'dropped'
  onBuild(applyPast: boolean): void
  onEdit?(): void
  onDrop(): void
  testId?: string
}): ReactNode {
  const { t, lang } = useApp()
  const [past, setPast] = useState(false)
  return (
    <div
      className="flex flex-col gap-2 rounded-[12px] border border-ws-line bg-ws-card p-3"
      data-testid={testId}
    >
      <div className="flex flex-col gap-0.5">
        <div className="text-[13px] font-medium">{name}</div>
        <div className="text-[12px] text-ws-body" data-testid="rule-proposal-plain">
          {plain}
        </div>
      </div>

      <div className="flex flex-col gap-1" data-testid="rule-proposal-trial">
        <div className="flex items-center gap-1.5 text-[12px] text-ws-muted-fg">
          <span className="ws-num" data-matched={trial.matched}>
            {t('message_rules.trial.matched', { n: trial.matched })}
          </span>
          <Hint text={t('message_rules.trial.hint')} />
        </div>
        {trial.sample.length === 0 ? null : (
          <ul className="flex flex-col gap-0.5 text-[12px]">
            {trial.sample.map((s) => (
              <li
                key={s.message_id}
                className="flex min-w-0 gap-1.5"
                data-testid="rule-proposal-sample"
              >
                <span className="truncate">{s.subject || t('message_rules.no_subject')}</span>
                <span className="shrink-0 text-ws-muted-fg">{s.from}</span>
              </li>
            ))}
          </ul>
        )}
        {trial.ai_skipped === true ? (
          <p className="text-[12px] text-ws-muted-fg">{t('message_rules.trial.ai_skipped')}</p>
        ) : null}
        {trial.credits === undefined ? null : (
          <p className="text-[12px] text-ws-muted-fg" data-testid="rule-proposal-credits">
            {t('message_rules.trial.credits', { n: trial.credits })}
          </p>
        )}
      </div>

      {trial.changed.length === 0 ? null : (
        <div
          className="flex flex-col gap-1 rounded-lg bg-ws-warn-bg px-2.5 py-2"
          data-testid="rule-proposal-changed"
        >
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-ws-warn">
            {t('message_rules.trial.changed', { n: trial.changed.length })}
            <Hint text={t('message_rules.trial.changed.hint')} />
          </div>
          <ul className="flex flex-col gap-0.5 text-[12px]">
            {trial.changed.slice(0, 5).map((c) => (
              <li key={c.message_id} className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate">{c.subject || c.from}</span>
                <span className="shrink-0 text-ws-muted-fg">
                  {destinationLabel(t, positions, lang, c.before)}
                </span>
                <ArrowRight aria-hidden className="size-3 shrink-0 text-ws-muted-fg" />
                <span className="shrink-0">{destinationLabel(t, positions, lang, c.after)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {decided !== undefined ? (
        <p className="text-[12px] text-ws-muted-fg" data-testid="rule-proposal-decided">
          {t(decided === 'built' ? 'message_rules.built' : 'message_rules.dropped')}
        </p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-[12px] text-ws-muted-fg">
            <input
              type="checkbox"
              data-testid="rule-proposal-past"
              checked={past}
              onChange={(e) => {
                setPast(e.target.checked)
              }}
            />
            {t('message_rules.apply_past')}
            <Hint text={t('message_rules.apply_past.hint')} />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              data-testid="rule-proposal-build"
              disabled={busy}
              onClick={() => {
                onBuild(past)
              }}
            >
              {t(editing === true ? 'message_rules.save' : 'message_rules.build')}
            </Button>
            {onEdit === undefined ? null : (
              <Button
                size="sm"
                variant="outline"
                data-testid="rule-proposal-edit"
                disabled={busy}
                onClick={onEdit}
              >
                {t('message_rules.edit')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              data-testid="rule-proposal-drop"
              disabled={busy}
              onClick={onDrop}
            >
              {t('message_rules.drop')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
