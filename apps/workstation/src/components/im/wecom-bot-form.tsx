/**
 * 企业微信机器人那张**本机原生表单**（BotID + Secret，WP85 / WP211）——从消息渠道页拆出来，
 * **消息渠道页与连接卡共用这一个件**（WP334，决策 725：企业微信表单放进卡里，连好自动接着做）。
 *
 * 13 §4.3 的原生表单：值用 FormData 收，不进 React state、不进任何全局变量，提交只打 `PUT /v1/im/wecom`，
 * 提交完立刻 reset()。全程没有一次 console.*。Secret 不经 AI、不进卡的载荷 / 决定 / 事件。
 * 公司的应用凭据只有负责人 / 公司管理员能填（Fable 09-30），别人看到一句「由负责人来连」。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { saveWecomBot } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function WecomBotForm({ canManage }: { canManage: boolean }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const formRef = useRef<HTMLFormElement>(null)
  const botIdId = useId()
  const secretId = useId()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: saveWecomBot,
    onSuccess: async () => {
      setError(null)
      setSaved(true)
      // 13 §4.3：提交完 DOM 里也不留
      formRef.current?.reset()
      await client.invalidateQueries({ queryKey: ['im'] })
    },
    onError: (e: Error) => {
      setError(e.message)
      formRef.current?.reset()
    },
  })

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const bot_id = String(form.get('bot_id') ?? '').trim()
    const secret = String(form.get('secret') ?? '').trim()
    if (bot_id === '' || secret === '') return
    save.mutate({ bot_id, secret })
  }

  return (
    <>
      {canManage ? (
        <form
          ref={formRef}
          onSubmit={submit}
          className="flex max-w-md flex-col gap-3"
          data-testid="wecom-form"
        >
          <div>
            <Label htmlFor={botIdId} className="gap-1.5">
              {t('im.wecom.bot_id')}
              <Hint text={t('im.wecom.where')} />
            </Label>
            <Input id={botIdId} name="bot_id" autoComplete="off" spellCheck={false} required />
          </div>
          <div>
            <Label htmlFor={secretId}>{t('im.wecom.secret')}</Label>
            <Input
              id={secretId}
              name="secret"
              type="password"
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
              required
            />
          </div>
          <div>
            <Button type="submit" size="sm" disabled={save.isPending}>
              {t('im.wecom.save')}
            </Button>
          </div>
        </form>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {saved && error === null ? (
        <p className="text-sm text-muted-foreground" data-slot="status">
          {t('im.wecom.done')}
        </p>
      ) : null}
    </>
  )
}
