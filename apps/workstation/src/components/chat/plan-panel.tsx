/**
 * 沙盒页右边那一栏：这一轮 AI 判了什么（WP57）。
 *
 * 36 §2「卡片说人话」的同一条纪律：**不出裸枚举**。`answer` / `human_review`
 * 这些名字是给代码看的，商家看到的是"直接答""要你定"。
 * 解释性文字进 tooltip（36 §7 三档：可见 / tooltip / 折叠区）。
 */
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import type { ChatTurnView } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 五种动作各自的语气：要人定的那两种是警示色，AI 自己能走完的是中性。 */
const TONE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  answer: 'secondary',
  collect_info: 'secondary',
  human_review: 'destructive',
  assist: 'default',
  handoff: 'outline',
}

export function ChatPlanPanel({ turn }: { turn: ChatTurnView | undefined }): React.ReactNode {
  const { t } = useApp()
  if (turn === undefined || turn.plan === undefined) {
    return (
      <Card data-testid="chat-plan-empty">
        <CardHeader>
          <CardTitle className="text-sm">{t('chat.plan.title')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{t('chat.plan.empty')}</CardContent>
      </Card>
    )
  }
  const plan = turn.plan
  /*
   * WP417（决策 1232）：「能答」的那一句缺省也先出卡等你批——这时标签说「先给你批」，不说「直接答」
   * （摘要那一行同理：说的是起草好了等你批）。
   */
  const held = plan.action === 'answer' && turn.approval_item_id !== undefined
  const label = held ? 'answer_held' : plan.action
  return (
    <Card data-testid="chat-plan" data-action={plan.action}>
      <CardHeader className="gap-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          {t('chat.plan.title')}
          <Badge variant={TONE[plan.action] ?? 'secondary'} data-testid="chat-plan-action">
            {t(`chat.action.${label}`)}
          </Badge>
          <Hint text={t(`chat.action.${label}.why`)} testId="chat-plan-why" />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          {held ? t('chat.action.answer_held.why') : plan.summary}
        </p>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t('chat.plan.intent')}</dt>
          <dd data-testid="chat-plan-intent">{t(`chat.intent.${plan.intent}`)}</dd>
          <dt className="flex items-center gap-1 text-muted-foreground">
            {t('chat.plan.money')}
            <Hint text={t('chat.plan.money.why')} />
          </dt>
          <dd data-testid="chat-plan-money">
            {plan.money_touch ? t('chat.plan.money.yes') : t('chat.plan.money.no')}
          </dd>
          {plan.missing_info.length > 0 ? (
            <>
              <dt className="text-muted-foreground">{t('chat.plan.missing')}</dt>
              <dd data-testid="chat-plan-missing">{plan.missing_info.join('、')}</dd>
            </>
          ) : null}
          <dt className="flex items-center gap-1 text-muted-foreground">
            {t('chat.plan.model')}
            <Hint text={t('chat.plan.model.why')} />
          </dt>
          <dd data-testid="chat-plan-model">
            {turn.used_model ? t('chat.plan.model.yes') : t('chat.plan.model.no')}
          </dd>
        </dl>

        {turn.approval_item_id === undefined ? null : (
          <div className="flex items-center gap-2" data-testid="chat-plan-card">
            <span className="text-xs text-muted-foreground">{t('chat.plan.card')}</span>
            <Button size="xs" variant="outline" asChild>
              <Link to="/">{t('chat.plan.card.open')}</Link>
            </Button>
          </div>
        )}

        {turn.blocked === undefined ? null : (
          <p role="status" className="text-xs text-destructive" data-testid="chat-plan-blocked">
            {t('chat.plan.blocked', { reason: turn.blocked })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
