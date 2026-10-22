/**
 * WP475：左栏左下角、用户名旁那颗「反馈」图标按钮（tooltip 一句话）。左栏收成图标列时叠在头像上面。
 */
import { MessageSquareText } from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp } from '@/lib/app-context'
import { openFeedback } from '@/lib/feedback'

export function FeedbackButton(): ReactNode {
  const { t } = useApp()
  return (
    <button
      type="button"
      data-testid="feedback-button"
      aria-label={t('feedback.button')}
      title={t('feedback.button.hint')}
      className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      onClick={() => {
        openFeedback('new')
      }}
    >
      <MessageSquareText aria-hidden className="size-4" />
    </button>
  )
}
