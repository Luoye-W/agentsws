/**
 * 消息渠道页上的飞书 / 钉钉两张卡（WP211）。
 *
 * 照 WP210 的少字规矩：卡上只有 **图标 + 名字 + 问号 + 状态 + 主按钮**；一句话介绍进问号，
 * 「凭据只存本机、不经 AI」进 Secret 那一格的问号，步骤进教程（`docs/help/im-feishu.md` /
 * `im-dingtalk.md`）。图标是各自官网的 favicon（构建期抓进仓库，运行时不联网）。
 *
 * 两件事在卡上：
 * 1. **公司的应用凭据**（一次，谁填都行）：原生 `<form>`，值用 `FormData` 收，不进 React state，
 *    提交完立刻 `reset()`；存好之后只显示 App ID / Client ID（不是秘密），Secret 永不回显。
 * 2. **我的账号**（每人一次）：拿一个 6 位绑定码，私聊机器人发「绑定 123456」。机器人只替
 *    认得的同事作答——认人靠这一步，不靠管理员手工对表。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { BrandIcon } from '@/components/brand-icons'
import { TutorialLink } from '@/components/help/tutorial-link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  type ImTeamBotView,
  type ImTeamChannel,
  issueImBindCode,
  removeDingtalkBot,
  removeFeishuBot,
  saveDingtalkBot,
  saveFeishuBot,
  unbindImAccount,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import type { HelpSlug } from '@/lib/help'

type Channel = 'feishu' | 'dingtalk'

interface Spec {
  icon: string
  slug: HelpSlug
  title: string
  what: string
  saved: string
  where: string
  idField: { name: string; label: string }
  secretField: { name: string; label: string }
  save(form: FormData): Promise<unknown> | undefined
  remove(): Promise<unknown>
}

const SPECS: Record<Channel, Spec> = {
  feishu: {
    icon: 'feishu_bot',
    slug: 'im-feishu',
    title: 'im.feishu.title',
    what: 'im.feishu.what',
    saved: 'im.feishu.saved',
    where: 'im.feishu.where',
    idField: { name: 'app_id', label: 'im.feishu.app_id' },
    secretField: { name: 'app_secret', label: 'im.feishu.app_secret' },
    save: (form) => {
      const app_id = String(form.get('app_id') ?? '').trim()
      const app_secret = String(form.get('app_secret') ?? '').trim()
      if (app_id === '' || app_secret === '') return undefined
      return saveFeishuBot({
        app_id,
        app_secret,
        domain: form.get('lark') === 'on' ? 'lark' : 'feishu',
      })
    },
    remove: removeFeishuBot,
  },
  dingtalk: {
    icon: 'dingtalk_bot',
    slug: 'im-dingtalk',
    title: 'im.dingtalk.title',
    what: 'im.dingtalk.what',
    saved: 'im.dingtalk.saved',
    where: 'im.dingtalk.where',
    idField: { name: 'client_id', label: 'im.dingtalk.client_id' },
    secretField: { name: 'client_secret', label: 'im.dingtalk.client_secret' },
    save: (form) => {
      const client_id = String(form.get('client_id') ?? '').trim()
      const client_secret = String(form.get('client_secret') ?? '').trim()
      if (client_id === '' || client_secret === '') return undefined
      return saveDingtalkBot({ client_id, client_secret })
    },
    remove: removeDingtalkBot,
  },
}

/** 状态徽章：在收信 / 连接中 / 连不上 / 没配。 */
function StateBadge({ view }: { view: ImTeamBotView | undefined }): ReactNode {
  const { t } = useApp()
  if (view?.configured !== true)
    return <Badge variant="outline">{t('im.state.unconfigured')}</Badge>
  if (view.state === 'connected') return <Badge variant="default">{t('im.state.live')}</Badge>
  if (view.state === 'failed') return <Badge variant="destructive">{t('im.state.failed')}</Badge>
  return <Badge variant="secondary">{t('im.state.connecting')}</Badge>
}

export function TeamBotCard({
  channel,
  view,
  accountId,
  canManage,
}: {
  channel: Channel
  view: ImTeamBotView | undefined
  /** 负责人与公司管理员才看得到填 / 改 / 断开；别人只看状态。 */
  canManage: boolean
  /** 存好的 App ID / Client ID（不是秘密）。 */
  accountId: string | undefined
}): ReactNode {
  const { t } = useApp()
  const spec = SPECS[channel]
  const client = useQueryClient()
  const formRef = useRef<HTMLFormElement>(null)
  const idInput = useId()
  const secretInput = useId()
  const larkInput = useId()
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const configured = view?.configured === true
  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: ['im'] })

  const save = useMutation({
    mutationFn: (form: FormData) => spec.save(form) ?? Promise.resolve(undefined),
    onSuccess: async () => {
      setError(null)
      setDone(true)
      setEditing(false)
      // 13 §4.3：提交完 DOM 里也不留
      formRef.current?.reset()
      await refresh()
    },
    onError: (e: Error) => {
      setError(e.message)
      formRef.current?.reset()
    },
  })

  const remove = useMutation({
    mutationFn: spec.remove,
    onSuccess: async () => {
      setDone(false)
      await refresh()
    },
  })

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    save.mutate(new FormData(e.currentTarget))
  }

  // 少字：没配时卡上只有一个主按钮，点开才出表单
  const showForm = editing && canManage
  return (
    <Card data-testid={`im-${channel}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <BrandIcon provider={spec.icon} size={20} className="rounded" />
          {t(spec.title)}
          <Hint text={t(spec.what)} testId={`im-${channel}-what`} />
          <TutorialLink slug={spec.slug} className="font-normal" />
        </CardTitle>
        <StateBadge view={view} />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {configured && accountId !== undefined ? (
          <p className="text-sm" data-slot="status">
            {t(spec.saved, { id: accountId })}
          </p>
        ) : null}
        {view?.error !== undefined ? (
          <p role="alert" className="text-sm text-destructive">
            {view.error}
          </p>
        ) : null}
        {showForm ? (
          <form ref={formRef} onSubmit={submit} className="flex max-w-md flex-col gap-3">
            <div>
              <Label htmlFor={idInput} className="gap-1.5">
                {t(spec.idField.label)}
                <Hint text={t(spec.where)} />
              </Label>
              <Input
                id={idInput}
                name={spec.idField.name}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div>
              <Label htmlFor={secretInput} className="gap-1.5">
                {t(spec.secretField.label)}
                <Hint text={t('im.team.secret.hint')} />
              </Label>
              <Input
                id={secretInput}
                name={spec.secretField.name}
                type="password"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                required
              />
            </div>
            {channel === 'feishu' ? (
              <Label htmlFor={larkInput} className="gap-2 font-normal">
                <input id={larkInput} name="lark" type="checkbox" className="size-4" />
                {t('im.feishu.lark')}
              </Label>
            ) : null}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={save.isPending}>
                {t('im.team.save')}
              </Button>
              {editing ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  {t('im.wechat.cancel')}
                </Button>
              ) : null}
            </div>
          </form>
        ) : !canManage ? null : !configured ? (
          <div>
            <Button size="sm" onClick={() => setEditing(true)}>
              {t('im.team.setup')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              {t('im.team.refill')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t('im.team.remove')}
            </Button>
            <Hint text={t('im.team.remove.why')} />
          </div>
        )}
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {done && error === null && view?.state !== 'connected' ? (
          <p className="text-sm text-muted-foreground" data-slot="status">
            {t('im.team.done')}
          </p>
        ) : null}
        {configured ? <BindRow channel={channel} bound={view?.me_bound === true} /> : null}
      </CardContent>
    </Card>
  )
}

/** 「绑定我的账号」：拿码 → 私聊机器人发出去；绑上了就只剩一个解绑。 */
export function BindRow({ channel, bound }: { channel: ImTeamChannel; bound: boolean }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [code, setCode] = useState<string | null>(null)
  const issue = useMutation({
    mutationFn: issueImBindCode,
    onSuccess: (out) => setCode(out.code),
  })
  const unbind = useMutation({
    mutationFn: () => unbindImAccount(channel),
    onSuccess: async () => {
      setCode(null)
      await client.invalidateQueries({ queryKey: ['im'] })
    },
  })

  if (bound)
    return (
      <div className="flex items-center gap-2 border-t pt-3" data-testid={`im-${channel}-bound`}>
        <span className="text-sm" data-slot="status">
          {t('im.team.bound')}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={unbind.isPending}
          onClick={() => unbind.mutate()}
        >
          {t('im.team.unbind')}
        </Button>
      </div>
    )
  return (
    <div className="flex flex-col gap-2 border-t pt-3" data-testid={`im-${channel}-bind`}>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={issue.isPending}
          onClick={() => issue.mutate()}
        >
          {t('im.team.bind')}
        </Button>
        <Hint text={t('im.team.bind.why')} />
      </div>
      {code !== null ? (
        <p className="flex items-center gap-1 text-sm" data-slot="status">
          {t('im.team.bind.send')}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono" data-slot="data">
            {t('im.team.bind.cmd', { code })}
          </code>
          <Hint text={t('im.team.bind.expires')} />
        </p>
      ) : null}
      {issue.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {issue.error.message}
        </p>
      ) : null}
    </div>
  )
}
