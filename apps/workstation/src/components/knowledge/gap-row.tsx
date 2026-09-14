/**
 * 缺口一行（48 §4 #9）：Agent 答不上来的一个问题，两种补法。
 *
 * **只有两种**，而且都是打字：
 * 1. 贴一条外部链接（进 `media`）——帮助中心页、教程视频、商品图；
 * 2. 粘一段文字口径（进正文）。
 *
 * 没有上传、没有图床、没有富文本编辑器。理由是这一步是商家在手机上顺手补的，
 * 多一个控件就多一次放弃；而链接与文字这两样，任何人在任何设备上都给得出来。
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { KnowledgeGapRow } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function GapRow({
  gap,
  busy,
  onAnswer,
}: {
  gap: KnowledgeGapRow
  busy: boolean
  onAnswer(answer: string): void
}): React.ReactNode {
  const { t } = useApp()
  const [mode, setMode] = useState<'none' | 'link' | 'text'>('none')
  const [value, setValue] = useState('')

  const submit = (): void => {
    const answer = value.trim()
    if (answer === '') return
    onAnswer(answer)
    setValue('')
    setMode('none')
  }

  return (
    <li className="space-y-2 border-b py-3 last:border-b-0" data-testid="knowledge-gap">
      <p className="text-sm">{gap.question}</p>
      <p className="text-xs text-muted-foreground">{gap.subject.key}</p>
      {mode === 'none' ? (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setMode('link')}>
            {t('knowledge.gap.paste_link')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMode('text')}>
            {t('knowledge.gap.paste_text')}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {mode === 'link' ? (
            <Input
              value={value}
              placeholder="https://…"
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <Textarea
              value={value}
              rows={3}
              placeholder={t('knowledge.gap.text_placeholder')}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || value.trim() === ''} onClick={submit}>
              {t('knowledge.gap.submit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('none')}>
              {t('knowledge.gap.cancel')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('knowledge.gap.note')}</p>
        </div>
      )}
    </li>
  )
}
