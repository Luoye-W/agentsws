/**
 * WP171（Fable 终审）：「第二批」短标签——这条职责的 YAML 已经建好（`status: planned`），
 * 第一版还不做。只是一个标签，说明进问号（36 §7 少字）。向导与岗位页共用这一个。
 */
import { Badge } from '@/components/ui/badge'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'

export function PlannedTag({ testId = 'role-planned' }: { testId?: string }): React.ReactNode {
  const { t } = useApp()
  return (
    <span className="inline-flex items-center gap-0.5" data-testid={testId}>
      <Badge variant="secondary">{t('role.planned')}</Badge>
      <Hint text={t('role.planned.hint')} />
    </span>
  )
}
