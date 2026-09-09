/**
 * 指导抽屉（36 §2.1「指导（instruct）不是聊天」）。
 *
 * **先选作用域，再一句话**：作用域决定它落到哪里（本条回复 / 技能 overlay 提案 /
 * 职责策略变更审批项），所以它是必填的，不是个附注。没选作用域时提交按钮是禁用的。
 */
import type { InstructionScope } from '@agentsws/deck'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { useApp } from '@/lib/app-context'

const SCOPES: InstructionScope[] = ['single_reply', 'similar_cases', 'global_rule']

export function DeckInstructSheet({
  open,
  onOpenChange,
  onSubmit,
  busy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (instruction: { scope: InstructionScope; text: string }) => void
  busy?: boolean
}): React.ReactNode {
  const { t } = useApp()
  const [scope, setScope] = useState<InstructionScope | ''>('')
  const [text, setText] = useState('')
  const ready = scope !== '' && text.trim() !== ''

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setScope('')
          setText('')
        }
        onOpenChange(next)
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('card.instruct.title')}</SheetTitle>
          <SheetDescription>{t('card.instruct.scope')}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4">
          <RadioGroup
            value={scope}
            onValueChange={(v) => {
              setScope(v as InstructionScope)
            }}
            aria-label={t('card.instruct.scope')}
          >
            {SCOPES.map((s) => (
              <Label key={s} className="flex items-center gap-2 font-normal">
                <RadioGroupItem value={s} />
                <span>{t(`card.instruct.scope.${s}`)}</span>
              </Label>
            ))}
          </RadioGroup>
          <div className="flex flex-col gap-2">
            <Label htmlFor="instruct-text">{t('card.instruct.text')}</Label>
            <Textarea
              id="instruct-text"
              rows={4}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
              }}
            />
          </div>
        </div>
        <SheetFooter>
          <Button
            disabled={!ready || busy === true}
            onClick={() => {
              if (scope === '') return
              onSubmit({ scope, text: text.trim() })
            }}
          >
            {t('card.instruct.submit')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
