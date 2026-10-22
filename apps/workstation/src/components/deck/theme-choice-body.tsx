/**
 * WP304（决策 445）：**选主题卡**的主体（「选一个」家族）。
 *
 * 第一行是我们的高级主题（一句卖点 + 价格 + 预览图 / 示例店占位）；下面是店里已装的免费主题（能改的能选，
 * 太老的只列不选）；店里一份能改的都没有就给一个「去主题商店装 Horizon」的链接。界面少字：一行一个选项，不铺说明。
 * 选项来自服务端（`card.options`），这里只是把它画得认得出——不编第三个选项。
 */
import type { ThemeChoicePayload } from '@agentsws/contracts'
import { ExternalLink, ImageIcon, Sparkles } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useApp } from '@/lib/app-context'

export const isThemeChoicePayload = (p: unknown): p is ThemeChoicePayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === 'theme_choice' &&
  Array.isArray((p as { store_themes?: unknown }).store_themes)

const Tag = ({ children, tone }: { children: React.ReactNode; tone: 'brand' | 'muted' }) => (
  <span
    className={
      tone === 'brand'
        ? 'rounded-full bg-ws-brand px-1.5 py-px text-xs text-ws-brand-fg'
        : 'rounded-full bg-ws-tint px-1.5 py-px text-xs text-ws-muted-fg'
    }
  >
    {children}
  </span>
)

export function ThemeChoiceBody({
  payload,
  options,
  option,
  onOption,
}: {
  payload: ThemeChoicePayload
  options: { id: string; label: string }[]
  option: string
  onOption: (id: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const ids = new Set(options.map((o) => o.id))
  const premium = payload.premium
  const canPremium = ids.has('premium')
  const usable = payload.store_themes.filter((x) => ids.has(`store:${x.id}`))
  const tooOld = payload.store_themes.filter((x) => !ids.has(`store:${x.id}`))
  const isLive = (role: string): boolean => role === 'main' || role === 'live'
  return (
    <RadioGroup
      value={option}
      onValueChange={onOption}
      className="mt-2.5 flex flex-col gap-2"
      data-testid="theme-choice"
    >
      {/* 高级主题：排第一 */}
      <Label
        data-testid="theme-choice-premium"
        data-status={premium.status}
        className={`flex items-center gap-3 rounded-lg border p-2.5 font-normal ${
          canPremium ? 'border-ws-brand bg-ws-card' : 'border-ws-line bg-ws-surface opacity-70'
        }`}
      >
        {canPremium ? <RadioGroupItem value="premium" /> : <span className="w-4" />}
        {premium.preview_image_url === undefined ? (
          <span className="flex h-11 w-16 shrink-0 items-center justify-center rounded-md bg-ws-tint text-ws-muted-fg">
            <ImageIcon className="size-4" aria-hidden />
          </span>
        ) : (
          <img
            src={premium.preview_image_url}
            alt=""
            className="h-11 w-16 shrink-0 rounded-md object-cover"
          />
        )}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm text-ws-ink">
            <Sparkles className="size-3.5 text-ws-brand" aria-hidden />
            {t('themes.choice.premium')}
            {canPremium ? <Tag tone="brand">{t('themes.choice.recommended')}</Tag> : null}
            {premium.status === 'soon' ||
            premium.status === 'needs_account' ||
            premium.status === 'needs_scope' ||
            premium.status === 'offline' ? (
              <Tag tone="muted">{t(`themes.choice.premium.${premium.status}`)}</Tag>
            ) : null}
          </span>
          <span className="truncate text-xs text-ws-muted-fg">
            {t('themes.choice.premium.tagline')}
          </span>
          <span className="text-xs text-ws-body" data-testid="theme-choice-price">
            {premium.status === 'owned'
              ? t('themes.choice.premium.owned')
              : t('themes.choice.premium.price', {
                  price: `$${premium.price_usd}`,
                  credits: premium.price_credits,
                })}
          </span>
        </span>
        {premium.example_url === undefined ? null : (
          <a
            href={premium.example_url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto shrink-0 text-xs text-ws-brand"
            onClick={(e) => e.stopPropagation()}
          >
            {t('themes.choice.premium.example')}
          </a>
        )}
      </Label>

      {/* 店里的免费主题 */}
      <span className="px-1 pt-1 text-xs text-ws-muted-fg">{t('themes.choice.free')}</span>
      {usable.map((x) => (
        <Label
          key={x.id}
          className="flex items-center gap-2 rounded-lg bg-ws-surface p-2.5 font-normal"
          data-testid="theme-choice-store"
        >
          <RadioGroupItem value={`store:${x.id}`} />
          <span className="text-sm text-ws-ink">{x.name}</span>
          {isLive(x.role) ? <Tag tone="muted">{t('themes.choice.live')}</Tag> : null}
          {x.theme_name === 'Horizon' ? (
            <Tag tone="brand">{t('themes.choice.recommended')}</Tag>
          ) : null}
          {x.theme_name !== undefined && x.theme_name !== x.name ? (
            <span className="truncate text-xs text-ws-muted-fg">
              {[x.theme_name, x.theme_version].filter(Boolean).join(' ')}
            </span>
          ) : null}
        </Label>
      ))}
      {tooOld.map((x) => (
        <div
          key={x.id}
          className="flex items-center gap-2 rounded-lg p-2.5 pl-8 text-sm text-ws-muted-fg"
          data-testid="theme-choice-too-old"
        >
          <span className="line-through">{x.name}</span>
          <Tag tone="muted">{t('themes.choice.too_old')}</Tag>
        </div>
      ))}
      {usable.length === 0 ? (
        <div className="flex items-center gap-2 px-1 text-xs text-ws-muted-fg">
          {t('themes.choice.none')}
          <a
            href={payload.theme_store_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-ws-brand"
            data-testid="theme-choice-store-link"
          >
            {t('themes.choice.store_link')}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </div>
      ) : null}
    </RadioGroup>
  )
}
