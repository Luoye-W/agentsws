/**
 * 公司档案（46 §1 ①）：全称、可选的邮箱域名、"让同事找到我"开关。
 *
 * 向导第 ① 步与设置页用的是同一个件——46 §1 末段说的"后续从公司页和设置页都能改"，
 * 靠的就是它只有一份。
 *
 * 那句"只交换一串哈希"是 36 §7 的**可见**档（安全承诺不许藏进 tooltip）：
 * 用户凭它决定要不要把开关打开。
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint, SafetyNote } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { WorkspaceProfileView } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export interface ProfileDraft {
  legal_name: string
  domain: string
  discoverable: boolean
}

export function ProfileForm({
  profile,
  emailHint,
  busy,
  saved,
  error,
  onSave,
}: {
  profile?: WorkspaceProfileView
  /** 登录邮箱——域名那一格从它带出来（46 §1 表 ①）。 */
  emailHint?: string
  busy: boolean
  saved: boolean
  error?: string
  onSave(draft: ProfileDraft): void
}): React.ReactNode {
  const { t } = useApp()
  const suggested = emailHint?.split('@')[1] ?? ''
  const [draft, setDraft] = useState<ProfileDraft>({
    legal_name: profile?.legal_name ?? '',
    domain: profile?.domain ?? suggested,
    discoverable: profile?.discoverable ?? true,
  })

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="onboarding-profile">
      <div className="flex flex-col gap-1">
        <Label htmlFor="company-legal-name" className="flex items-center gap-1">
          {t('onboarding.company.legal_name')}
          <Hint text={t('onboarding.company.legal_name.hint')} testId="company-name-hint" />
        </Label>
        <Input
          id="company-legal-name"
          data-testid="company-legal-name"
          value={draft.legal_name}
          placeholder={t('onboarding.company.legal_name.placeholder')}
          onChange={(e) => {
            setDraft({ ...draft, legal_name: e.target.value })
          }}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="company-domain" className="flex items-center gap-1">
          {t('onboarding.company.domain')}
          <Hint text={t('onboarding.company.domain.hint')} />
        </Label>
        <Input
          id="company-domain"
          data-testid="company-domain"
          value={draft.domain}
          placeholder="nordvolt.cn"
          onChange={(e) => {
            setDraft({ ...draft, domain: e.target.value })
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="company-discoverable" className="flex items-center gap-1">
          {t('onboarding.company.discoverable')}
          <Hint text={t('onboarding.company.discoverable.hint')} />
        </Label>
        <Switch
          id="company-discoverable"
          data-testid="company-discoverable"
          checked={draft.discoverable}
          onCheckedChange={(next) => {
            setDraft({ ...draft, discoverable: next })
          }}
        />
      </div>
      <SafetyNote text={t('onboarding.company.promise')} />

      {error === undefined ? null : (
        <p role="alert" className="text-destructive" data-testid="company-error">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        {saved ? (
          <span className="text-xs text-muted-foreground" data-testid="company-saved">
            {t('onboarding.company.saved')}
          </span>
        ) : null}
        <Button
          size="sm"
          data-testid="company-save"
          disabled={busy || draft.legal_name.trim() === ''}
          onClick={() => {
            onSave(draft)
          }}
        >
          {t('onboarding.company.save')}
        </Button>
      </div>
    </div>
  )
}
