/**
 * 分析完那一屏：**一张可编辑的品牌档案卡**（70 §3.5）。
 *
 * 这张卡要同时说清三件平常界面上分不开的事：
 *
 * 1. **这一格是我们替你填的**（不是你填的）——所以每一格旁边有一支铅笔；
 * 2. **这一格我们有多大把握**——`low` 的挂一个「请确认」，其余不挂。不挂的
 *    不代表一定对，只代表**我们没有理由专门叫你看**；到处都挂等于哪儿都没挂；
 * 3. **这个值是哪儿来的**——出处不铺在外面（36 §7：解释进 tooltip），
 *    鼠标停在把握度标上才出现"取自 <网址> 的 <哪一段>"。
 *
 * 图形化优先（Luoye 09-17 那条减字原则）：logo 画出来、主色画成色块、商品画成
 * 缩略图、市场与语言画成标签。**能画的不写字**。
 *
 * 用户改过的格子挂一个「已改」而不是「请确认」——那一格已经是他说了算的，
 * 重新分析也不会动它（70 §3.4）。
 */

import type { BrandIntakeProfile } from '@agentsws/contracts'
import { Check, Pencil } from 'lucide-react'
import { useState } from 'react'
import { DesignSpecRow } from '@/components/design-md/design-spec-row'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useApp } from '@/lib/app-context'

/**
 * 卡上出现的那几格，以及它们的顺序。
 *
 * WP142（docs/78 第 5 步）：**「公司全称」不在卡上**——它下面那张「公司名与你的称呼」表单里
 * 已经有一格，两处各写一个值，用户不知道哪个算数。分析出来的全称直接预填进那一格
 * （`BusinessStep`），只有一个来源。
 */
const TEXT_FIELDS = ['brand_name', 'one_liner', 'category', 'support_email', 'currency'] as const

type TextField = (typeof TEXT_FIELDS)[number]

/**
 * WP142：标签说人话——语言 `zh-CN` → 「中文（中国）」、市场 `US` → 「美国」、
 * 社媒 `instagram` → 「Instagram」。认不出来的原样给（总比一片空白强）。
 */
export function languageLabel(code: string, lang: 'zh' | 'en'): string {
  try {
    return (
      new Intl.DisplayNames([lang === 'zh' ? 'zh-CN' : 'en'], { type: 'language' }).of(code) ?? code
    )
  } catch {
    return code
  }
}

export function marketLabel(code: string, lang: 'zh' | 'en'): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return code
  try {
    return (
      new Intl.DisplayNames([lang === 'zh' ? 'zh-CN' : 'en'], { type: 'region' }).of(
        code.toUpperCase(),
      ) ?? code
    )
  } catch {
    return code
  }
}

const SOCIAL_LABELS: Readonly<Record<string, { zh: string; en: string }>> = {
  instagram: { zh: 'Instagram', en: 'Instagram' },
  facebook: { zh: 'Facebook', en: 'Facebook' },
  tiktok: { zh: 'TikTok', en: 'TikTok' },
  youtube: { zh: 'YouTube', en: 'YouTube' },
  x: { zh: 'X（推特）', en: 'X (Twitter)' },
  pinterest: { zh: 'Pinterest', en: 'Pinterest' },
  linkedin: { zh: '领英', en: 'LinkedIn' },
  weibo: { zh: '微博', en: 'Weibo' },
  xiaohongshu: { zh: '小红书', en: 'Xiaohongshu' },
}

export function socialLabel(platform: string, lang: 'zh' | 'en'): string {
  const hit = SOCIAL_LABELS[platform]
  if (hit !== undefined) return hit[lang]
  return platform.charAt(0).toUpperCase() + platform.slice(1)
}

/**
 * WP142：商品价带上币种。`1299.00` + `USD` → 「US$1,299.00」；币种认不出或价不是数就原样。
 */
export function priceLabel(price: string, currency: string | undefined, lang: 'zh' | 'en'): string {
  const n = Number(price.replace(/,/g, ''))
  if (currency === undefined || currency === '' || !Number.isFinite(n)) return price
  try {
    return new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(n)
  } catch {
    return price
  }
}

export interface BrandProfileCardProps {
  profile: BrandIntakeProfile
  /** 用户改过的那几格（字段名 → 新值）。受控：父组件握着它，确认时原样发上去。 */
  edits: Record<string, unknown>
  onEdit: (field: string, value: string) => void
  onConfirm: () => void
  onReanalyze: () => void
  busy?: boolean
  /** WP142：已经点过「看着没问题」了——给一句回执，按钮换成「已确认」。 */
  confirmed?: boolean
}

/** 一格的当前值：用户改过就是他改的那个，否则是分析出来的。 */
function currentValue(
  profile: BrandIntakeProfile,
  edits: Record<string, unknown>,
  key: TextField,
): string {
  const edited = edits[key]
  if (typeof edited === 'string') return edited
  const found = (profile as Record<string, { value?: unknown } | undefined>)[key]
  return typeof found?.value === 'string' ? found.value : ''
}

/**
 * 把握度那个小标。
 *
 * **只有 `low` 出「请确认」**。`high` / `medium` 什么都不出——一个到处都是
 * 标记的界面等于没有标记，用户会整片略过，于是真正要看的那一格也被略过了。
 */
function ConfidenceTag({
  profile,
  edits,
  field,
}: {
  profile: BrandIntakeProfile
  edits: Record<string, unknown>
  field: string
}): React.ReactNode {
  const { t } = useApp()
  const cell = (
    profile as Record<
      string,
      | { confidence?: string; evidence?: { url: string; locator: string }[]; edited?: boolean }
      | undefined
    >
  )[field]
  if (cell === undefined) return null
  if (edits[field] !== undefined || cell.edited === true)
    return (
      <span className="text-[11px] text-ws-muted-fg" data-testid={`intake-tag-${field}`}>
        {t('intake.tag.edited')}
      </span>
    )
  if (cell.confidence !== 'low') return null
  const from = cell.evidence?.[0]
  return (
    <span
      className="rounded-sm bg-amber-100 px-1 text-[11px] text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
      data-testid={`intake-tag-${field}`}
      // 出处进 tooltip，不铺在外面（36 §7）
      title={
        from === undefined
          ? undefined
          : t('intake.evidence', { url: from.url, locator: from.locator })
      }
    >
      {t('intake.tag.confirm')}
    </span>
  )
}

/** 一行：标签 + 值 + 把握度小标 + 一支铅笔。 */
function Row({
  field,
  profile,
  edits,
  onEdit,
}: {
  field: TextField
  profile: BrandIntakeProfile
  edits: Record<string, unknown>
  onEdit: (field: string, value: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const value = currentValue(profile, edits, field)
  // 抓不到又没改过的格子**整行不出**：一行空格子比没有这一行更糟
  if (value === '' && !open) return null
  return (
    <div className="flex items-baseline gap-2 text-sm" data-testid={`intake-row-${field}`}>
      <span className="w-24 shrink-0 text-ws-muted-fg">{t(`intake.field.${field}`)}</span>
      {open ? (
        <Input
          autoFocus
          className="h-7"
          data-testid={`intake-input-${field}`}
          value={value}
          onChange={(e) => {
            onEdit(field, e.target.value)
          }}
          onBlur={() => {
            setOpen(false)
          }}
        />
      ) : (
        <>
          <span data-testid={`intake-value-${field}`}>{value}</span>
          <ConfidenceTag profile={profile} edits={edits} field={field} />
          <button
            type="button"
            aria-label={t('intake.edit')}
            data-testid={`intake-edit-${field}`}
            className="text-ws-muted-fg hover:text-foreground"
            onClick={() => {
              setOpen(true)
            }}
          >
            <Pencil size={12} />
          </button>
        </>
      )}
    </div>
  )
}

export function BrandProfileCard({
  profile,
  edits,
  onEdit,
  onConfirm,
  onReanalyze,
  busy = false,
  confirmed = false,
}: BrandProfileCardProps): React.ReactNode {
  const { t, lang } = useApp()
  const currency = currentValue(profile, edits, 'currency')
  const logo = profile.logo_url?.value
  const color = profile.primary_color?.value
  const products = profile.products?.value ?? []
  const markets = profile.markets?.value ?? []
  const languages = profile.languages?.value ?? []
  const socials = profile.social_links?.value ?? []
  const policies = profile.policies?.value ?? []

  return (
    <div className="flex flex-col gap-4" data-testid="brand-profile-card">
      {/* 头：logo + 色块。能画的不写字 */}
      <div className="flex items-center gap-3">
        {logo === undefined ? null : (
          <img
            src={logo}
            alt=""
            className="h-10 w-10 rounded-sm object-contain"
            data-testid="intake-logo"
            // 图挂了就整个不画（WP121b）：一张"看着没问题"的卡上摆一个碎图标，
            // 用户第一眼看见的是我们的失误，而不是他的品牌
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        )}
        {color === undefined ? null : (
          <span
            className="h-6 w-6 rounded-full border"
            style={{ backgroundColor: color }}
            title={color}
            data-testid="intake-color"
          />
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        {TEXT_FIELDS.map((f) => (
          <Row key={f} field={f} profile={profile} edits={edits} onEdit={onEdit} />
        ))}
      </div>

      {/* 市场 / 语言 / 社媒：画成标签 */}
      {markets.length + languages.length + socials.length === 0 ? null : (
        <div className="flex flex-wrap gap-1" data-testid="intake-tags">
          {[
            ...markets.map((m) => marketLabel(m, lang)),
            ...languages.map((l) => languageLabel(l, lang)),
            ...socials.map((s) => socialLabel(s.platform, lang)),
          ]
            .filter((label, i, all) => all.indexOf(label) === i)
            .map((label) => (
              <span
                key={label}
                className="rounded-sm bg-ws-subtle px-1.5 py-0.5 text-[11px]"
                data-testid="intake-tag"
              >
                {label}
              </span>
            ))}
        </div>
      )}

      {/* 商品：画成缩略图 */}
      {products.length === 0 ? null : (
        <div className="flex flex-wrap gap-2" data-testid="intake-products">
          {products.slice(0, 6).map((p) => (
            <figure key={p.title} className="w-20 text-[11px]">
              {p.image_url === undefined ? null : (
                <img
                  src={p.image_url}
                  alt=""
                  className="h-20 w-20 rounded-sm object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                  }}
                />
              )}
              <figcaption className="truncate" title={p.title}>
                {p.title}
              </figcaption>
              {p.price_snapshot === undefined ? null : (
                <span className="text-ws-muted-fg" data-testid="intake-price">
                  {priceLabel(p.price_snapshot, currency === '' ? undefined : currency, lang)}
                </span>
              )}
            </figure>
          ))}
        </div>
      )}

      {policies.length === 0 ? null : (
        <p className="text-xs text-ws-muted-fg" data-testid="intake-policies">
          {t('intake.policies', { count: policies.length })}
        </p>
      )}

      {/* WP122（71）：这个品牌的设计规范。查不到就整行不出现（见组件内注释） */}
      <DesignSpecRow />

      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          data-testid="intake-reanalyze"
          onClick={onReanalyze}
        >
          {t('intake.reanalyze')}
        </Button>
        <Button
          size="sm"
          variant={confirmed ? 'outline' : 'default'}
          disabled={busy || confirmed}
          data-testid="intake-confirm"
          onClick={onConfirm}
        >
          <Check size={14} />
          {confirmed ? t('intake.confirmed.button') : t('intake.confirm')}
        </Button>
      </div>
      {/* WP142（docs/78 第 6 步）：点了要有一句回执，不只是按钮变淡 */}
      {confirmed ? (
        <p
          className="flex items-center gap-1.5 text-xs text-primary"
          data-testid="intake-confirmed"
        >
          <Check size={12} aria-hidden />
          {t('intake.confirmed')}
        </p>
      ) : null}
    </div>
  )
}
