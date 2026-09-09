/**
 * 动作行里就地展开的三块折叠区（37 §1 第 7 行：**点开前不在 DOM 里**）。
 *
 * 它们不是抽屉、不是弹窗，而是**替换掉动作行本身**——卡面永远一屏读完，人不会一边
 * 写指导一边看不见自己在给哪张卡写。渐进披露的意思也就是字面的意思：这些 textarea
 * 在被点开之前根本没有被 React 挂载过，测试可以直接断言 DOM 里没有它。
 */
import type { InstructionScope } from '@agentsws/deck'
import { INSTRUCTION_SCOPES } from '@agentsws/deck'
import { useState } from 'react'
import { AskAiPanel, type AskAiScope } from '@/components/deck/ask-ai-panel'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useApp } from '@/lib/app-context'

export type NoteMode = 'instruct' | 'reject'

export function DeckNotePanel({
  mode,
  busy,
  ask,
  onCancel,
  onSubmit,
}: {
  mode: NoteMode
  busy: boolean
  /** 问 AI 的边界（这张卡 / 这个事项）；不给就是禁用态 */
  ask?: AskAiScope | undefined
  onCancel: () => void
  onSubmit: (input: { text: string; scope?: InstructionScope }) => void
}): React.ReactNode {
  const { t } = useApp()
  const [text, setText] = useState('')
  const [scope, setScope] = useState<InstructionScope>('single_reply')
  // 指导必须有话；驳回也必须写原因（14 §4：它是最强的学习信号）。
  const ready = text.trim() !== ''

  return (
    <div className="flex flex-col gap-2" data-testid={`deck-panel-${mode}`}>
      <p className="text-xs text-muted-foreground">
        {mode === 'instruct' ? t('deck.instruct.hint') : t('deck.reject.hint')}
      </p>
      <Textarea
        autoFocus
        rows={3}
        aria-label={mode === 'instruct' ? t('card.instruct.text') : t('deck.reject.hint')}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
        }}
      />
      {mode === 'instruct' ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="deck-scopes">
          <span className="text-muted-foreground">{t('card.instruct.scope')}</span>
          {INSTRUCTION_SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              className={
                scope === s
                  ? 'rounded-full border border-primary bg-primary px-2.5 py-0.5 text-primary-foreground'
                  : 'rounded-full border px-2.5 py-0.5 text-muted-foreground hover:text-foreground'
              }
              onClick={() => {
                setScope(s)
              }}
            >
              {t(`card.instruct.scope.${s}`)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !ready}
          onClick={() => {
            onSubmit({ text: text.trim(), ...(mode === 'instruct' ? { scope } : {}) })
          }}
        >
          {busy ? t('deck.submitting') : t('deck.submit')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('deck.back')}
        </Button>
      </div>
      {/*
        36 §3 的第二个对话入口，就挂在指导区里。语义与上面那个框相反且必须一眼看得出来：
        指导会变成 AI 对客户说的话，问 AI 不会（面板自带那行标注）。
      */}
      {mode === 'instruct' ? <AskAiPanel {...(ask === undefined ? {} : { scope: ask })} /> : null}
    </div>
  )
}

/**
 *「需要补素材」= `ai_question` 的反向入口（37 §1 第 6 行）。
 *
 * 正向的 `ai_question` 是 AI 问人「这条缺资料」；这里是人对 AI 说同一句话。v1 只有
 * 前端形态：`/v1` 上还没有这个入口（WP19 的「问 AI 单轮入口」一起做），所以面板明说
 * 为什么点不动，而不是假装提交成功。
 */
export function DeckSupplementPanel({
  onCancel,
  onSnooze,
}: {
  onCancel: () => void
  onSnooze: () => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="flex flex-col gap-2" data-testid="deck-panel-supplement">
      <p className="text-sm font-medium">{t('deck.supplement.title')}</p>
      <p className="text-xs text-muted-foreground">{t('deck.supplement.hint')}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onSnooze}>
          {t('deck.supplement.snooze')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('deck.back')}
        </Button>
      </div>
    </div>
  )
}
