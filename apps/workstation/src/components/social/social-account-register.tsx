/**
 * WP419（决策 1231，自查 S2）：内容账号组「登记要发帖的号」——贴主页链接就行，**不用开发者应用、不用令牌**。
 * 到点了插件打开你登录着的发帖页、你点发布；官方接口只作可选加速（连接页里还在）。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiClientError, registerSocialAccount, type SocialChannelId } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 这条渠道的主页链接认哪几家的站。 */
const HOSTS: Readonly<Partial<Record<SocialChannelId, RegExp>>> = {
  facebook: /(^|\.)facebook\.com$/u,
  instagram: /(^|\.)instagram\.com$/u,
  threads: /(^|\.)threads\.(net|com)$/u,
  linkedin: /(^|\.)linkedin\.com$/u,
  tiktok: /(^|\.)tiktok\.com$/u,
  x: /^(x|twitter)\.com$|\.x\.com$/u,
  youtube: /(^|\.)youtube\.com$/u,
}

/** 链接认不认得（https、这条渠道的站）。 */
export function accountUrlOk(channel: SocialChannelId, raw: string): boolean {
  try {
    const u = new URL(raw.trim())
    const re = HOSTS[channel]
    return u.protocol === 'https:' && re !== undefined && re.test(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function canRegisterAccount(channel: SocialChannelId): boolean {
  return HOSTS[channel] !== undefined
}

export function SocialAccountRegister(props: {
  channel: SocialChannelId
  assignment: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const save = useMutation({
    mutationFn: () =>
      registerSocialAccount(
        { channel: props.channel, url: url.trim(), display_name: name },
        props.assignment,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['social-accounts'] })
    },
  })
  const ok = accountUrlOk(props.channel, url)
  return (
    <form
      className="flex flex-col gap-1.5"
      data-testid="social-account-register"
      onSubmit={(e) => {
        e.preventDefault()
        if (ok) save.mutate()
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('social.register.url')}
          aria-label={t('social.register.url')}
          className="h-7 min-w-0 flex-1 text-[13px]"
          data-testid="social-account-url"
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('social.register.name')}
          aria-label={t('social.register.name')}
          className="h-7 w-28 text-[13px]"
        />
        <Button
          size="xs"
          type="submit"
          disabled={!ok || save.isPending}
          data-testid="social-account-save"
        >
          {t('social.register.save')}
        </Button>
      </div>
      <p className="text-[12px] text-ws-muted-fg">{t('social.register.why')}</p>
      {save.error === null ? null : (
        <p role="alert" className="text-[12px] text-destructive">
          {save.error instanceof ApiClientError ? save.error.message : t('error.generic')}
        </p>
      )}
    </form>
  )
}
