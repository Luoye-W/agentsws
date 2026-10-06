/**
 * WP242（Fable 10-06 真机）：第 ② 步网站读不到时，**就地手填**品牌资料。
 *
 * 以前点「先跳过，手动填品牌资料」只得到一句「之后在设置里填」——没有地方填。
 * 这里就是那几格：品牌名、一句话、客服邮箱、币种、市场（与分析出来的档案卡同名同形，
 * 存下去走的是与「看着没问题」同一条写法）。都可以空着，至少填一格才能存。
 */
import { useState } from 'react'
import { MarketsPicker } from '@/components/onboarding/markets-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ManualBrandProfile } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 表单里的几格 → 发出去的那一份（空格不发；币种大写）。 */
export function manualEdits(draft: {
  brand_name: string
  one_liner: string
  support_email: string
  currency: string
  markets: string[]
}): ManualBrandProfile {
  const text = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim())
  const out: ManualBrandProfile = {}
  const brand = text(draft.brand_name)
  if (brand !== undefined) out.brand_name = brand
  const line = text(draft.one_liner)
  if (line !== undefined) out.one_liner = line
  const email = text(draft.support_email)
  if (email !== undefined) out.support_email = email
  const currency = text(draft.currency)
  if (currency !== undefined) out.currency = currency.toUpperCase()
  if (draft.markets.length > 0) out.markets = [...draft.markets]
  return out
}

export function ManualProfileForm({
  brandName = '',
  busy,
  onSave,
}: {
  /** 预填的品牌名（建品牌时起的那个）。 */
  brandName?: string
  busy: boolean
  onSave: (edits: ManualBrandProfile) => void
}): React.ReactNode {
  const { t } = useApp()
  const [draft, setDraft] = useState({
    brand_name: brandName,
    one_liner: '',
    support_email: '',
    currency: '',
    markets: [] as string[],
  })
  const edits = manualEdits(draft)
  const text = (
    key: 'brand_name' | 'one_liner' | 'support_email' | 'currency',
    extra: { type?: string; maxLength: number; placeholder?: string },
  ): React.ReactNode => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`manual-${key}`}>{t(`intake.field.${key}`)}</Label>
      <Input
        id={`manual-${key}`}
        data-testid={`manual-${key}`}
        type={extra.type ?? 'text'}
        maxLength={extra.maxLength}
        {...(extra.placeholder === undefined ? {} : { placeholder: extra.placeholder })}
        value={draft[key]}
        onChange={(e) => {
          const value = e.target.value
          setDraft((prev) => ({ ...prev, [key]: value }))
        }}
      />
    </div>
  )
  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      data-testid="manual-profile-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (Object.keys(edits).length > 0) onSave(edits)
      }}
    >
      <p className="font-medium">{t('onboarding.business.manual.title')}</p>
      {text('brand_name', { maxLength: 80 })}
      {text('one_liner', { maxLength: 200 })}
      {text('support_email', { type: 'email', maxLength: 200 })}
      {text('currency', { maxLength: 3, placeholder: 'USD' })}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t('intake.field.markets')}</span>
        <MarketsPicker
          value={draft.markets}
          onChange={(markets) => {
            setDraft((prev) => ({ ...prev, markets }))
          }}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        className="self-start"
        disabled={busy || Object.keys(edits).length === 0}
        data-testid="manual-save"
      >
        {t('onboarding.business.manual.save')}
      </Button>
    </form>
  )
}
