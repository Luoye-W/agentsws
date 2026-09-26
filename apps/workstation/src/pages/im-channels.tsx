/**
 * 消息渠道页（WP85；54 §5）。
 *
 * 两格，说的是两件不一样的事：
 *
 * 1. **微信（我自己的）**——这不是客服渠道。扫完码之后，它只是「你和你自己的
 *    代理的私聊」：同事加不了这个号，也拉不进群，它不会替你回任何人。
 *    这一段文案必须在界面上说清楚，因为微信这个入口太容易被当成客服入口用，
 *    而条款 6.1 / 6.4 违规是**牵连主微信账号**的——被封的是用户本人的号。
 * 2. **企业微信机器人（公司的）**——这一格才是团队用的：群里 @ 它，它按提问人的
 *    身份去问那个人自己的代理。
 *
 * 两格共同的一条：**审批动作不在 IM 里做**。卡片在微信 / 企业微信里只有一段
 * 文字摘要 + 一条「去工作台处理」的链接，按钮一个都没有（凭据与决策不经 IM）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { TutorialLink } from '@/components/help/tutorial-link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint, SafetyNote } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getImStatus,
  type ImLoginPoll,
  pollWechatLogin,
  saveWecomBot,
  startWechatLogin,
  unbindWechat,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 轮询节奏：服务端那一跳自己是长轮询（最长 35s），这里只管别把它打穿。 */
const POLL_MS = 1200

export function ImChannelsPage(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const status = useQuery({ queryKey: ['im', 'status'], queryFn: getImStatus })
  const [login, setLogin] = useState<{ id: string; qrcode_url: string } | null>(null)
  const [poll, setPoll] = useState<ImLoginPoll | null>(null)
  const [verify, setVerify] = useState('')
  const [wecomSaved, setWecomSaved] = useState(false)
  const [wecomError, setWecomError] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const botIdId = useId()
  const secretId = useId()

  const refresh = useCallback(async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['im'] })
  }, [client])

  const begin = useMutation({
    mutationFn: startWechatLogin,
    onSuccess: (out) => {
      setPoll(null)
      setVerify('')
      setLogin({ id: out.login_id, qrcode_url: out.qrcode_url })
    },
  })

  const unbind = useMutation({
    mutationFn: unbindWechat,
    onSuccess: async () => {
      setLogin(null)
      setPoll(null)
      await refresh()
    },
  })

  const saveWecom = useMutation({
    mutationFn: saveWecomBot,
    onSuccess: async () => {
      setWecomError(null)
      setWecomSaved(true)
      // 13 §4.3：提交完 DOM 里也不留
      formRef.current?.reset()
      await refresh()
    },
    onError: (e: Error) => {
      setWecomError(e.message)
      formRef.current?.reset()
    },
  })

  /** 扫码期间按节奏问状态；连上 / 过期 / 失败就停。 */
  useEffect(() => {
    if (login === null) return
    let alive = true
    const tick = async (): Promise<void> => {
      if (!alive) return
      try {
        const out = await pollWechatLogin(login.id, verify === '' ? undefined : verify)
        if (!alive) return
        setPoll(out)
        if (out.qrcode_url !== undefined)
          setLogin((prev) => (prev === null ? prev : { ...prev, qrcode_url: out.qrcode_url ?? '' }))
        if (out.status === 'confirmed' || out.status === 'already_connected') {
          setLogin(null)
          await refresh()
          return
        }
        if (out.status === 'expired' || out.status === 'failed') {
          setLogin(null)
          return
        }
      } catch {
        // 一次网络抖动不该把扫码中断；下一拍接着问
      }
      if (alive) timer = setTimeout(() => void tick(), POLL_MS)
    }
    let timer = setTimeout(() => void tick(), POLL_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // verify 变了要立刻带上去（填了配对码之后）
  }, [login, verify, refresh])

  if (status.isPending) return <Skeleton className="h-96 w-full" />
  if (status.error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{status.error.message}
      </p>
    )
  }

  const wechat = status.data?.wechat
  const wecom = status.data?.wecom

  const submitWecom = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const bot_id = String(form.get('bot_id') ?? '').trim()
    const secret = String(form.get('secret') ?? '').trim()
    if (bot_id === '' || secret === '') return
    saveWecom.mutate({ bot_id, secret })
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-3 text-xl font-semibold">
          {t('im.title')}
          <TutorialLink slug="im-channels" className="font-normal" />
        </h1>
        {/* WP157：页头一句；「两条通道是两件事」进问号 */}
        <p className="mt-1 flex max-w-3xl items-center gap-1 text-sm text-muted-foreground">
          {t('im.intro')}
          <Hint text={t('im.intro.hint')} />
        </p>
      </div>

      {/* ── 微信：我和我自己的代理 ─────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">{t('im.wechat.title')}</CardTitle>
          {wechat?.bound === true ? (
            <Badge variant={wechat.live ? 'default' : 'secondary'}>
              {wechat.live ? t('im.state.live') : t('im.state.paused')}
            </Badge>
          ) : (
            <Badge variant="outline">{t('im.state.unbound')}</Badge>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/* WP157：一句话 + 问号（原来那段介绍）；「它不做的三件事」与条款原话进安全承诺旁的问号 */}
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            {t('im.wechat.line')}
            <Hint text={t('im.wechat.what')} testId="im-wechat-what" />
          </p>
          <SafetyNote
            text={t('im.wechat.terms.short')}
            hint={[
              t('im.wechat.terms'),
              t('im.wechat.not.colleagues'),
              t('im.wechat.not.group'),
              t('im.wechat.not.approve'),
            ].join(' ')}
          />
          <SafetyNote text={t('im.wechat.local')} />

          {wechat?.allowed === false ? (
            <p role="alert" className="text-sm text-destructive">
              {wechat.reason}
            </p>
          ) : wechat?.bound === true ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                {t('im.wechat.bound', { account: wechat.account_id ?? '' })}
              </p>
              {wechat.paused_until !== undefined ? (
                <p role="alert" className="text-sm text-destructive">
                  {t('im.wechat.stale')}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={begin.isPending}
                  onClick={() => {
                    begin.mutate()
                  }}
                >
                  {t('im.wechat.rescan')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={unbind.isPending}
                  onClick={() => {
                    unbind.mutate()
                  }}
                >
                  {t('im.wechat.unbind')}
                </Button>
              </div>
              <Hint text={t('im.wechat.unbind.why')} />
            </div>
          ) : login === null ? (
            <div>
              <Button
                size="sm"
                disabled={begin.isPending}
                onClick={() => {
                  begin.mutate()
                }}
              >
                {t('im.wechat.scan')}
              </Button>
              {begin.error !== null ? (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {begin.error.message}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <img
                src={login.qrcode_url}
                alt={t('im.wechat.qr.alt')}
                className="size-48 rounded border bg-white p-2"
              />
              <p className="text-sm">{poll?.message ?? t('im.wechat.qr.hint')}</p>
              {poll?.status === 'need_verify_code' ? (
                <div className="flex max-w-xs items-end gap-2">
                  <div className="flex-1">
                    <Label htmlFor="im-verify">{t('im.wechat.verify')}</Label>
                    <Input
                      id="im-verify"
                      value={verify}
                      inputMode="numeric"
                      autoComplete="off"
                      onChange={(e) => {
                        setVerify(e.target.value)
                      }}
                    />
                  </div>
                </div>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLogin(null)
                  setPoll(null)
                }}
              >
                {t('im.wechat.cancel')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 企业微信：团队那一条 ───────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">{t('im.wecom.title')}</CardTitle>
          {wecom?.configured === true ? (
            <Badge variant={wecom.connected ? 'default' : 'secondary'}>
              {wecom.connected ? t('im.state.live') : t('im.state.connecting')}
            </Badge>
          ) : (
            <Badge variant="outline">{t('im.state.unconfigured')}</Badge>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            {t('im.wecom.line')}
            <Hint text={t('im.wecom.what')} testId="im-wecom-what" />
          </p>
          {wecom?.configured === true ? (
            <p className="text-sm" data-slot="status">
              {t('im.wecom.saved', { bot: wecom.bot_id ?? '' })}
            </p>
          ) : null}
          {/*
            13 §4.3 的原生表单：值用 FormData 收，不进 React state、不进任何全局变量，
            提交完立刻 reset()。全程没有一次 console.*。
          */}
          <form ref={formRef} onSubmit={submitWecom} className="flex max-w-md flex-col gap-3">
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
            <SafetyNote text={t('im.wecom.safety')} />
            <div>
              <Button type="submit" size="sm" disabled={saveWecom.isPending}>
                {t('im.wecom.save')}
              </Button>
            </div>
          </form>
          {wecomError !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {wecomError}
            </p>
          ) : null}
          {wecomSaved && wecomError === null ? (
            <p className="text-sm text-muted-foreground" data-slot="status">
              {t('im.wecom.done')}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <SafetyNote text={t('im.cards.note')} />
    </div>
  )
}
