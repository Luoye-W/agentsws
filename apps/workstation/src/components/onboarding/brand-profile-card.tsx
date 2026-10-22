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

import type {
  BrandIntakeInsightsStatus,
  BrandIntakeProfile,
  BrandIntakeWebReport,
} from '@agentsws/contracts'
import { Check, Pencil } from 'lucide-react'
import { useState } from 'react'
import { DesignSpecRow } from '@/components/design-md/design-spec-row'
import {
  AiTag,
  BrandInsightFields,
  INSIGHT_KEYS,
  type InsightKey,
  type InsightValues,
  type SourceItem,
} from '@/components/onboarding/brand-insight-fields'
import { MarketsPicker, marketLabel } from '@/components/onboarding/markets-picker'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { useApp } from '@/lib/app-context'

/**
 * 卡上出现的那几格，以及它们的顺序。
 *
 * WP142（docs/78 第 5 步）：**「公司全称」不在卡上**——它下面那张「公司名与你的称呼」表单里
 * 已经有一格，两处各写一个值，用户不知道哪个算数。分析出来的全称直接预填进那一格
 * （`BusinessStep`），只有一个来源。
 */
const TEXT_FIELDS = [
  'brand_name',
  'one_liner',
  'category',
  'support_email',
  // WP424：邮件营销用的哪一家——这一格空着也摆出来（第 ④ 步只按它列邮件平台）
  'email_service',
  'currency',
] as const

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

export { marketLabel }

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
  /** 文字格给字符串；WP166 市场那一格给国家码数组。 */
  onEdit: (field: string, value: unknown) => void
  onConfirm: () => void
  onReanalyze: () => void
  busy?: boolean
  /** WP142：已经点过「看着没问题」了——给一句回执，按钮换成「已确认」。 */
  confirmed?: boolean
  /**
   * WP244：官网是刚开的 Shopify 空店——明说一句「品牌资料请自己填」，
   * 品牌名 / 一句话两格空着也摆出来（点铅笔就能填），不再整行藏起来。
   */
  freshStore?: boolean
  /** WP346：AI 归纳那一步怎么样了（没接模型 / 积分封顶 / 没答好时说一句）。 */
  insights?: BrandIntakeInsightsStatus
  /** WP349：联网查那一步怎么样了（没联网 / 额度没查 / 没搜成时照实说一句）。 */
  web?: BrandIntakeWebReport
}

/** WP349：一格的网页来源（证据里层 `web` 的那几条；人改过的格子不挂——那已经是人的话了）。 */
export function webSourcesOf(
  profile: BrandIntakeProfile,
  edits: Record<string, unknown>,
): Partial<Record<InsightKey, SourceItem[]>> {
  const out: Partial<Record<InsightKey, SourceItem[]>> = {}
  for (const key of ['positioning', 'audience', 'price_band', 'subcategory'] as const) {
    const cell = profile[key]
    if (cell === undefined || edits[key] !== undefined || cell.edited === true) continue
    const list = cell.evidence
      .filter((e) => e.locator === 'web')
      .map((e) => ({ url: e.url, ...(e.quote === undefined ? {} : { title: e.quote }) }))
    if (list.length > 0) out[key] = list
  }
  return out
}

/**
 * WP349：联网那一步照实说的几句（没联网、没搜成、额度没查哪几部分、搜了但没找到有来源的竞品）。
 * 只在 AI 归纳真跑了时说（没跑时 `insights` 那一句已经说过了）。
 */
export function webNotes(
  web: BrandIntakeWebReport | undefined,
  competitors: number,
): { key: string; hint?: string }[] {
  if (web === undefined) return []
  if (web.status === 'off')
    return [{ key: 'intake.web.off', ...(web.reason === undefined ? {} : { hint: web.reason }) }]
  if (web.status === 'failed') return [{ key: 'intake.web.failed' }]
  const out: { key: string }[] = []
  const cut = web.cut ?? []
  if (cut.includes('competitors')) out.push({ key: 'intake.web.cut.competitors' })
  else if (cut.includes('verify')) out.push({ key: 'intake.web.cut.verify' })
  if (cut.includes('brand')) out.push({ key: 'intake.web.cut.brand' })
  if (web.status === 'done' && competitors === 0 && !cut.includes('competitors'))
    out.push({ key: 'intake.web.no_competitors' })
  return out
}

/** WP346：一格是不是 AI 填的（模型那一层出的、人没改过）。 */
function aiCell(profile: BrandIntakeProfile, edits: Record<string, unknown>, key: string): boolean {
  const cell = (profile as Record<string, { evidence?: { locator: string }[]; edited?: boolean }>)[
    key
  ]
  return (
    cell !== undefined &&
    edits[key] === undefined &&
    cell.edited !== true &&
    cell.evidence?.[0]?.locator === 'model'
  )
}

/** WP346：第二版那几格的当前值（改过的用改过的）。 */
function insightValuesOf(
  profile: BrandIntakeProfile,
  edits: Record<string, unknown>,
): InsightValues {
  const out: Record<string, unknown> = {}
  for (const key of INSIGHT_KEYS) {
    const v = edits[key] ?? (profile as Record<string, { value?: unknown } | undefined>)[key]?.value
    if (v !== undefined) out[key] = v
  }
  return out as InsightValues
}

/** WP244：空店时这两格空着也要摆出来（让人自己填）。 */
const FRESH_FIELDS: readonly TextField[] = ['brand_name', 'one_liner']

/** WP424：不管读没读到都摆出来的格子（「邮件营销用的」——没人说过，第 ④ 步就不替他列 Klaviyo）。 */
const ALWAYS_FIELDS: readonly TextField[] = ['email_service']

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
      <span className="text-xs text-ws-muted-fg" data-testid={`intake-tag-${field}`}>
        {t('intake.tag.edited')}
      </span>
    )
  if (cell.confidence !== 'low') return null
  const from = cell.evidence?.[0]
  return (
    <span
      className="rounded-sm bg-ws-warn-bg px-1 text-xs text-ws-warn"
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
  always = false,
}: {
  field: TextField
  profile: BrandIntakeProfile
  edits: Record<string, unknown>
  onEdit: (field: string, value: string) => void
  /** WP244：空着也摆出来（空店的品牌名 / 一句话：要人自己填）。 */
  always?: boolean
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const value = currentValue(profile, edits, field)
  // 抓不到又没改过的格子**整行不出**：一行空格子比没有这一行更糟（空店那两格除外）
  if (value === '' && !open && !always) return null
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
          <span
            data-testid={`intake-value-${field}`}
            className={value === '' ? 'text-ws-muted-fg' : undefined}
          >
            {value === '' ? t('intake.empty') : value}
          </span>
          <ConfidenceTag profile={profile} edits={edits} field={field} />
          {/* WP346：AI 填的（品类）再挂一个「AI 建议」 */}
          {aiCell(profile, edits, field) ? <AiTag field={field} /> : null}
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
  freshStore = false,
  insights,
  web,
}: BrandProfileCardProps): React.ReactNode {
  const { t, lang } = useApp()
  const currency = currentValue(profile, edits, 'currency')
  const logo = profile.logo_url?.value
  const color = profile.primary_color?.value
  const products = profile.products?.value ?? []
  // WP166：市场可增删——改过就用改过的那一份（空数组也算：人删光了）
  const editedMarkets = edits.markets
  const markets = Array.isArray(editedMarkets)
    ? editedMarkets.filter((m): m is string => typeof m === 'string')
    : (profile.markets?.value ?? [])
  const marketsEdited = Array.isArray(editedMarkets) || profile.markets?.edited === true
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

      {freshStore ? (
        <p
          role="status"
          className="rounded-md bg-ws-warn-bg px-2 py-1.5 text-xs text-ws-warn"
          data-testid="intake-fresh"
        >
          {t('intake.fresh')}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        {TEXT_FIELDS.map((f) => (
          <Row
            key={f}
            field={f}
            profile={profile}
            edits={edits}
            onEdit={onEdit}
            always={(freshStore && FRESH_FIELDS.includes(f)) || ALWAYS_FIELDS.includes(f)}
          />
        ))}
      </div>

      {/*
        WP346（决策 872）：AI 归纳的几格（定位 / 子品类 / 价格带 / 人群 / 关键词 / 竞品），
        每格可改、挂「AI 建议」；没接模型 / 封顶 / 没答好时说一句为什么空着。
      */}
      <BrandInsightFields
        values={insightValuesOf(profile, edits)}
        ai={INSIGHT_KEYS.filter((k) => aiCell(profile, edits, k))}
        edited={INSIGHT_KEYS.filter(
          (k) =>
            edits[k] !== undefined ||
            (profile as Record<string, { edited?: boolean } | undefined>)[k]?.edited === true,
        )}
        onChange={(field, value) => {
          onEdit(field, value)
        }}
        disabled={busy}
        sources={webSourcesOf(profile, edits)}
      />
      {insights === 'no_model' || insights === 'budget' || insights === 'failed' ? (
        <p className="text-xs text-ws-muted-fg" data-testid="intake-insights-note">
          {t(`intake.insights.${insights}`)}
        </p>
      ) : null}
      {/* WP349：联网那一步照实说（没联网 / 没搜成 / 额度没查的几部分） */}
      {insights === 'done'
        ? webNotes(web, insightValuesOf(profile, edits).competitors?.length ?? 0).map((n) => (
            <p
              key={n.key}
              role="status"
              className="flex items-center gap-1 text-xs text-ws-muted-fg"
              data-testid="intake-web-note"
            >
              {t(n.key)}
              {n.hint === undefined ? null : <Hint text={n.hint} />}
            </p>
          ))
        : null}

      {/*
        WP166：市场从只读标签改成可增删（国家选择器，中文国名）；出处进问号；
        一个都没看出来就明说「没看出来，请选一下」。确认时随 edits 一起写进档案（唯一来源）。
      */}
      <div className="flex items-baseline gap-2 text-sm" data-testid="intake-row-markets">
        <span className="w-24 shrink-0 text-ws-muted-fg">{t('intake.field.markets')}</span>
        <MarketsPicker
          value={markets}
          disabled={busy}
          onChange={(next) => {
            onEdit('markets', next)
          }}
          origin={
            marketsEdited
              ? { from: 'human' }
              : profile.markets === undefined
                ? undefined
                : {
                    from: profile.markets.evidence.every((e) => e.locator === 'url:host')
                      ? 'amazon'
                      : 'site',
                    evidence: profile.markets.evidence,
                  }
          }
        />
        <ConfidenceTag profile={profile} edits={edits} field="markets" />
      </div>

      {/* 语言 / 社媒：画成标签 */}
      {languages.length + socials.length === 0 ? null : (
        <div className="flex flex-wrap gap-1" data-testid="intake-tags">
          {[
            ...languages.map((l) => languageLabel(l, lang)),
            ...socials.map((s) => socialLabel(s.platform, lang)),
          ]
            .filter((label, i, all) => all.indexOf(label) === i)
            .map((label) => (
              <span
                key={label}
                className="rounded-sm bg-ws-subtle px-1.5 py-0.5 text-xs"
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
            <figure key={p.title} className="w-20 text-xs">
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
              {/* WP346：原价划线；规格进 tooltip（卡片不铺字） */}
              {p.list_price_snapshot === undefined ? null : (
                <span
                  className="ml-1 text-ws-muted-fg line-through"
                  data-testid="intake-list-price"
                  title={t('intake.product.list_price', {
                    price: priceLabel(
                      p.list_price_snapshot,
                      currency === '' ? undefined : currency,
                      lang,
                    ),
                  })}
                >
                  {priceLabel(p.list_price_snapshot, currency === '' ? undefined : currency, lang)}
                </span>
              )}
              {(p.specs ?? []).length === 0 ? null : (
                <span
                  className="flex items-center gap-1 text-ws-muted-fg"
                  data-testid="intake-specs"
                  title={(p.specs ?? []).map((x) => `${x.name}：${x.value}`).join('\n')}
                >
                  {t('intake.product.specs')} {(p.specs ?? []).length}
                  {(p.model_filled ?? []).length > 0 ? (
                    <AiTag field={`product-${p.title}`} />
                  ) : null}
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
