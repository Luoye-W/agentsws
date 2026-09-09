/**
 * 36 §3 三个对话入口之一：卡片 / 记录里的「问 AI」——**单轮、只你可见、不发给客户**。
 *
 * v1 是占位：`/v1` 上还没有这个入口，所以输入框与按钮是禁用的，并且明说为什么。
 * 前端不引入任何模型 SDK，也不会绕过网关自己去问模型。
 */
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useApp } from '@/lib/app-context'

export function AskAiPanel({ available = false }: { available?: boolean }): React.ReactNode {
  const { t } = useApp()
  return (
    <section className="rounded-lg border border-dashed p-3" data-testid="ask-ai-panel">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="size-3.5" aria-hidden />
        <span>{t('card.ask.title')}</span>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{t('card.ask.hint')}</p>
      <div className="flex gap-2">
        <Input
          disabled={!available}
          aria-label={t('card.ask.title')}
          placeholder={available ? '' : t('card.ask.unavailable')}
        />
        <Button size="sm" variant="outline" disabled={!available}>
          {t('card.ask.send')}
        </Button>
      </div>
    </section>
  )
}
