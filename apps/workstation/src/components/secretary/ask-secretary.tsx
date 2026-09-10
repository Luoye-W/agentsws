/**
 * 「问他的秘书」（41 §1.2 第一行）：一个人选、一个输入框、一句答案。
 *
 * 界面上不做任何判断——**答不答、答什么，全在服务端按对方设的公开级别算**。
 * 被拒的时候也照实显示那句"这个要问本人"，不粉饰成"暂无数据"。
 */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { askSecretary, type PersonCard, type SecretaryAnswer } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function AskSecretary({
  people,
  fixedPerson,
}: {
  /** 可选的人；给了 `fixedPerson` 就不出选择框 */
  people?: PersonCard[]
  fixedPerson?: { person_id: string; name: string }
}): React.ReactNode {
  const { t } = useApp()
  const options = people ?? []
  const [who, setWho] = useState(fixedPerson?.person_id ?? options[0]?.person_id ?? '')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<SecretaryAnswer | null>(null)

  const ask = useMutation({
    mutationFn: (input: { id: string; question: string }) => askSecretary(input.id, input.question),
    onSuccess: (out) => {
      setAnswer(out)
    },
  })

  const target = fixedPerson?.person_id ?? who
  const submit = (): void => {
    if (target === '' || question.trim() === '') return
    ask.mutate({ id: target, question: question.trim() })
  }

  return (
    <div className="flex flex-col gap-3" data-testid="ask-secretary">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_2fr]">
        {fixedPerson === undefined ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ask-who">{t('secretary.ask.who')}</Label>
            <select
              id="ask-who"
              data-testid="ask-who"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={who}
              onChange={(e) => {
                setWho(e.target.value)
              }}
            >
              {options.map((p) => (
                <option key={p.person_id} value={p.person_id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ask-question">{t('secretary.tab.ask')}</Label>
          <Input
            id="ask-question"
            data-testid="ask-question"
            value={question}
            placeholder={t('secretary.ask.placeholder')}
            onChange={(e) => {
              setQuestion(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
        </div>
      </div>
      <div>
        <Button
          size="sm"
          data-testid="ask-submit"
          disabled={ask.isPending || target === '' || question.trim() === ''}
          onClick={submit}
        >
          {t('secretary.ask.submit')}
        </Button>
      </div>

      {ask.error === null || ask.error === undefined ? null : (
        <p role="alert" className="text-destructive text-sm">
          {ask.error instanceof Error ? ask.error.message : String(ask.error)}
        </p>
      )}

      {answer === null ? (
        <p className="text-muted-foreground text-sm">{t('secretary.ask.empty')}</p>
      ) : (
        <div
          className="flex flex-col gap-1 rounded-md border bg-muted/40 p-3 text-sm"
          data-testid="ask-answer"
          data-kind={answer.kind}
          data-refused={answer.refused ? 'true' : 'false'}
        >
          <p>{answer.answer}</p>
          {answer.refer_to === undefined ? null : (
            <span className="text-muted-foreground text-xs" data-testid="ask-refer">
              {t('secretary.ask.refer', { role: answer.refer_to.role_name })}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
