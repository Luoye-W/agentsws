/**
 * 个人微信扫码绑定那一块（WP85 / WP214）——从消息渠道页拆出来，**消息渠道页与连接卡共用这一个件**
 * （WP334，决策 725：微信扫码放进卡里，连好自动接着做）。
 *
 * 一条线：没绑 → 「扫码连接」→ 二维码 + 按节奏问状态（要配对码就出一格）→ 连上 / 过期 / 失败就停；
 * 绑了 → 「重新扫码」「解绑」。条款风险那一行由外面那张卡自己放（页上与卡上各放各的）。
 *
 * 凭据纪律：这里没有任何令牌——服务端只给「绑没绑 / 账号名 / 二维码地址 / 这一步到哪了」。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useFresh } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  type ImLoginPoll,
  type ImStatusView,
  pollWechatLogin,
  startWechatLogin,
  unbindWechat,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 轮询节奏：服务端那一跳自己是长轮询（最长 35s），这里只管别把它打穿。 */
const POLL_MS = 1200

export function WechatBind({
  wechat,
  compact = false,
}: {
  wechat: ImStatusView['wechat'] | undefined
  /** 连接卡里：绑上了就不出「重新扫码 / 解绑」（卡上那一行画绿勾就够了）。 */
  compact?: boolean
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [login, setLogin] = useState<{ id: string; qrcode_url: string } | null>(null)
  const [poll, setPoll] = useState<ImLoginPoll | null>(null)
  const [verify, setVerify] = useState('')
  /** WP214：这一次打开里刚扫码连上的时刻——「已连上，去微信里说句话试试」只在两分钟内说。 */
  const [boundAt, setBoundAt] = useState<number | undefined>(undefined)
  const justBound = useFresh(boundAt)

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
          setBoundAt(Date.now())
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

  if (wechat?.allowed === false)
    return (
      <p role="alert" className="text-sm text-destructive">
        {wechat.reason}
      </p>
    )
  if (wechat?.bound === true) {
    if (compact) return null
    return (
      <div className="flex flex-col gap-2">
        {/* 「已连上（微信账号 …）。去微信里跟它说句话试试」只在刚扫完码的两分钟内说 */}
        {justBound ? (
          <p className="text-sm" data-slot="status" data-testid="im-wechat-bound">
            {t('im.wechat.bound', { account: wechat.account_id ?? '' })}
          </p>
        ) : null}
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
          {/* WP214：原来这个问号单独一行、孤零零挂在卡底；挪到它说的「解绑」旁边 */}
          <Hint
            text={t('im.wechat.unbind.why')}
            className="self-center"
            testId="im-wechat-unbind-why"
          />
        </div>
      </div>
    )
  }
  if (login === null)
    return (
      <div>
        <Button
          size="sm"
          disabled={begin.isPending}
          data-testid="im-wechat-scan"
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
    )
  return (
    <div className="flex flex-col gap-3">
      <img
        src={login.qrcode_url}
        alt={t('im.wechat.qr.alt')}
        className="size-48 rounded-sm border bg-white p-2"
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
  )
}
