/**
 * 复核卡（48 §4 #6）：源页改了、受管辖数值也变了，请人答一句。
 *
 * 三个选项是**冻结**的（`packages/knowledge` 的 `RECHECK_OPTIONS`）：
 * 确认没变 / 按新值更新 / 忽略。卡上必须把"从什么变成什么"摆出来——
 * 让人在不打开源页的情况下就能判断，这是这张卡存在的全部理由。
 */
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { KnowledgeRecheckRow } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** `duration:day:14` → `期限 14 天`。与后端的 `describeFactKeyZh` 同口径。 */
export function describeFactKey(key: string): string {
  const [c, a, b] = key.split(':')
  if (c === 'duration') {
    const unit = a === 'day' ? '天' : a === 'month' ? '个月' : '年'
    return `期限 ${b}${unit}`
  }
  if (c === 'money') return `金额 ${a} ${b}`
  if (c === 'percent') return `比例 ${a}%`
  if (c === 'currency') return `币种 ${a}`
  if (c === 'responsibility') return `责任方 ${a}`
  return key
}

export function RecheckCard({
  recheck,
  statement,
  busy,
  onResolve,
}: {
  recheck: KnowledgeRecheckRow
  /** 被标过时的那条知识的正文（拿来对照）。 */
  statement?: string
  busy: boolean
  onResolve(resolution: 'unchanged' | 'adopt_new' | 'ignore'): void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <Card data-testid="knowledge-recheck">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          {t('knowledge.recheck.title')}
          <Badge variant="outline">{t('knowledge.verification.stale')}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t('knowledge.recheck.why')}</p>
        {statement === undefined ? null : (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs">{statement}</p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t('knowledge.recheck.before')}</dt>
          <dd>{recheck.before.map(describeFactKey).join('、') || '—'}</dd>
          <dt className="text-muted-foreground">{t('knowledge.recheck.after')}</dt>
          <dd>{recheck.after.map(describeFactKey).join('、') || '—'}</dd>
        </dl>
        {recheck.proposed_statement === undefined ? null : (
          <p className="rounded-md border border-dashed px-3 py-2 text-xs">
            {recheck.proposed_statement}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => onResolve('unchanged')}>
            {t('knowledge.recheck.unchanged')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onResolve('adopt_new')}
          >
            {t('knowledge.recheck.adopt_new')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onResolve('ignore')}>
            {t('knowledge.recheck.ignore')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
