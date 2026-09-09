/** 知识库：v1 只做壳（36 §5 没把它列进完成标准，事实卡 / 话术 / 策略三层在 /v1/knowledge 上）。 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useApp } from '@/lib/app-context'

export function KnowledgePage(): React.ReactNode {
  const { t } = useApp()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('knowledge.title')}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {t('knowledge.placeholder')}
      </CardContent>
    </Card>
  )
}
