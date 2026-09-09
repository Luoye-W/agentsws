/**
 * 36 §3 三个对话入口之一：卡片 / 记录里的「问 AI」——**单轮、只你可见、不发给客户**。
 *
 * 后端是 `POST /v1/ask`（WP24）。前端不引入任何模型 SDK，也不会绕过网关自己去问模型；
 * 答案只留在这个面板里，不写进任何卡片、草稿或事项时间线。
 * 问 AI **一定有边界**：没有 `scope`（某张卡或某个事项）就是禁用态。
 */
import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { askAi } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export interface AskAiScope {
  matter_id?: string
  card_id?: string
}

export function AskAiPanel({
  scope,
  available = true,
}: {
  scope?: AskAiScope
  available?: boolean
}): React.ReactNode {
  const { t } = useApp()
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const bounded =
    scope !== undefined && (scope.matter_id !== undefined || scope.card_id !== undefined)
  const usable = available && bounded

  const send = (): void => {
    const text = question.trim()
    if (!usable || text === '' || busy || scope === undefined) return
    setBusy(true)
    setError(null)
    askAi({ scope, question: text })
      .then((res) => {
        setAnswer(res.answer)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <section className="rounded-lg border border-dashed p-3" data-testid="ask-ai-panel">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="size-3.5" aria-hidden />
        <span>{t('card.ask.title')}</span>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{t('card.ask.hint')}</p>
      <div className="flex gap-2">
        <Input
          disabled={!usable || busy}
          value={question}
          aria-label={t('card.ask.title')}
          placeholder={usable ? '' : t('card.ask.unavailable')}
          onChange={(e) => {
            setQuestion(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
        />
        <Button size="sm" variant="outline" disabled={!usable || busy} onClick={send}>
          {busy ? t('card.ask.sending') : t('card.ask.send')}
        </Button>
      </div>
      {answer === null ? null : (
        <p
          className="mt-2 whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-xs"
          data-testid="ask-ai-answer"
        >
          {answer}
        </p>
      )}
      {error === null ? null : (
        <p className="mt-2 text-xs text-destructive" data-testid="ask-ai-error">
          {error}
        </p>
      )}
    </section>
  )
}
