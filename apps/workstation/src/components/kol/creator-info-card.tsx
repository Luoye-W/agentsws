/** 移植自 KOLAgents `src/components/influencer/creator-info-card.tsx` @ 88d74b2c（Luoye 的产品，非模板代码）。 */
/**
 * WP500（决策 1758）：红人详情——KOLAgents 的「红人信息卡」，看一个人、决定要不要接着谈、核一封开发信时要的全部东西。
 *
 * **从上往下的顺序照搬**（KOLAgents 那一份磨了很久的结论）：
 * 疑似同一红人（会改变下面每个数的含义，所以放最上面）→ 头部（谁、哪个平台、在哪）→ 三格数字 / 分平台表 →
 * 评估结论（人点开就是来看它的，紧跟数字）→ 简介 → 合作历史 → 估值 → 账号质量 → 分项分 → 合作进度 →
 * 联系方式 → 开发信 → 追踪链接 → 交付物 → 合作档案 → 近期作品。
 *
 * 也照搬了它的两条纪律：
 * - **没东西就不画那一节**（「合作历史」标题下面写「暂无合作历史」——一整节只为告诉人这里什么都没有）；
 *   联系方式、开发信两节例外：它们是能动手的地方，空着也要在；
 * - 「这个数怎么算的」一律进问号（KOLAgents `InfoHint`，工坊是 `Hint`），卡上只留数和结论；
 *   要人别签这个人的那一句（红色）例外，永远看得见。
 *
 * 改的地方（工坊的数据与规矩）：
 * - 样式全换成工坊的令牌 / 共用件（`WsAvatar`、`StatusPill`、`CategoryTag`、`--ws-*`），深浅色跟着主题；
 * - 头像 / 横幅 / 近期作品封面是「存入红人池」时由本机服务缓存下来的（WP502，决策 1760 B），走同源地址；
 *   壳的「不加载外站图片」不放开，没缓存到的照旧一个字的头像、色块封面（`creator-media.tsx`）；
 * - 「AI 评估」那一格工坊是 `kol-core` 的确定性打分（不是模型），结论 = 总分 + 刷粉护栏那一句 + 最弱的分项；
 * - 体检 / 受众真实性 / 估值是插件面板那几份算法在服务端算好的（`KolCreatorDetail.checks`），
 *   KOLAgents 的云端深度报告（受众地域、付费真实性报告）工坊没有——见报告「缺什么」；
 * - 人工标签与审核决定（WP502，决策 1763 B）照 KOLAgents 补上（`creator-review.tsx`），只记本机；
 *   近期作品点了在浏览器里打开原作品（1764 B；KOLAgents 是内容详情抽屉）；
 * - 实体类型下拉、登记内容、生成追踪链接、折扣码这几节工坊没有对应的数据或接口，不画；
 * - 联系方式只有脱敏形态（服务端就不给明文）；开发信照旧出卡等人批。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Link2, Mail, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BrandIcon } from '@/components/brand-icons'
import { CategoryTag, StatusPill, type Tone } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  addKolContact,
  decideKolMerge,
  draftKolOutreach,
  getKolCollaborations,
  getKolMergeSuggestions,
  getKolOutreachDefaults,
  type KolChannelId,
  type KolCollaborationData,
  type KolCreatorChecksData,
  type KolCreatorDetailData,
  type KolCreatorProfileData,
  type KolOutreachData,
  saveKolOutreachDefaults,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { tOr } from '@/lib/humanize'
import { cn } from '@/lib/utils'
import {
  avgViewsOf,
  countryFlag,
  dayOf,
  formatCents,
  formatCount,
  formatEngagementRate,
  formatRatio,
  personAccounts,
} from './creator-display'
import { CreatorAvatar, CreatorBanner, WorkCover } from './creator-media'
import { CreatorPlatformBreakdown } from './creator-platform-table'
import { CreatorTagsPanel, ReviewBadge, ReviewSection } from './creator-review'
import { atHandle, CHANNEL_SERVICE } from './kol-channel'
import { errorText, KolError, KolReceipt, refreshCards } from './kol-shared'
import { CollabProgress } from './segmented-progress'

type Account = KolCreatorDetailData['accounts'][number]

/* ── 小件 ─────────────────────────────────────────────────────────────── */

/** 一节的标题行：名字、可选的「估算」小标、问号、右边一个动作（KOLAgents `SectionHeading`）。 */
function SectionHeading({
  title,
  hint,
  badge,
  action,
}: {
  title: string
  hint?: string | undefined
  badge?: ReactNode
  action?: ReactNode
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="flex min-w-0 items-center gap-1.5 text-sm font-medium" data-slot="title">
        {title}
        {badge}
        {hint === undefined ? null : <Hint text={hint} />}
      </h4>
      {action}
    </div>
  )
}

/** 「估算」小标：这一节的数是公开页面推出来的，不是平台官方数据。 */
function EstimatedTag(): ReactNode {
  const { t } = useApp()
  return <CategoryTag outline>{t('kol.info.estimated')}</CategoryTag>
}

/** 一节的外框（KOLAgents `rounded-lg border p-3`）。 */
function Block({
  children,
  className,
  testId,
}: {
  children: ReactNode
  className?: string
  testId?: string
}): ReactNode {
  return (
    <section
      className={cn('flex flex-col gap-2 rounded-lg border border-ws-line p-3', className)}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {children}
    </section>
  )
}

/** 一格数字（KOLAgents 详情顶上那条三格）。 */
function Figure({
  label,
  value,
  testId,
}: {
  label: string
  value: string
  testId?: string
}): ReactNode {
  return (
    <div className="min-w-0" {...(testId === undefined ? {} : { 'data-testid': testId })}>
      <div className="truncate text-xs leading-tight text-muted-foreground">{label}</div>
      <div className="ws-num truncate text-base font-semibold">{value}</div>
    </div>
  )
}

/** 分项条（KOLAgents `ScoreBar`）：低于 45 的那一项条子变红。 */
function ScoreBar({ label, value, why }: { label: string; value: number; why: string }): ReactNode {
  const alarming = value < 45
  return (
    <div
      className="grid grid-cols-[5.5rem_1fr_2rem] items-center gap-2 text-xs"
      data-testid="kol-score-bar"
    >
      <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
        <span className="truncate">{label}</span>
        {why === '' ? null : <Hint text={why} />}
      </span>
      <span className="h-2 overflow-hidden rounded-full bg-muted">
        <span
          className={cn('block h-full rounded-full', alarming ? 'bg-ws-bad' : 'bg-primary')}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </span>
      <span className="ws-num text-right font-medium">{value}</span>
    </div>
  )
}

/** 分数 → 三档（同红人卡 `ScoreHero`：≥80 主色、68–79 墨色、其余灰）。 */
function scoreTone(score: number): Tone {
  return score >= 80 ? 'good' : score >= 68 ? 'neutral' : 'warn'
}

/** 地区：账号上的两位码优先（国旗 + 本地语言的国名），没有就用存入红人池时页面上的原文。 */
function CreatorCountry({
  region,
  country,
}: {
  region: string | undefined
  country: string | undefined
}): ReactNode {
  const { lang } = useApp()
  const flag = countryFlag(region)
  let label = country
  if (region !== undefined && flag !== undefined) {
    try {
      label = new Intl.DisplayNames([lang === 'zh' ? 'zh-CN' : 'en'], { type: 'region' }).of(
        region.toUpperCase(),
      )
    } catch {
      label = region
    }
  }
  if (label === undefined || label === '') return null
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground"
      data-testid="kol-country"
    >
      {flag === undefined ? null : (
        <span aria-hidden className="text-base leading-none">
          {flag}
        </span>
      )}
      {label}
    </span>
  )
}

/* ── 疑似同一红人（KOLAgents `CreatorIdentityBanner`） ───────────────────── */

/**
 * 「这可能跟那个 45 万粉的 YouTuber 是同一个人」会改变下面每一个数的含义，所以放在最上面。
 * 没有建议时什么都不画。合 = 走合并建议那条「接受」（人点的就是批）；不是同一人 = 记下，不再提。
 * 合完保留的是更早那一条——它可能不是现在开着的这个人，所以把详情转过去。
 */
function IdentityBanner({
  assignment,
  creatorId,
  onRepoint,
}: {
  assignment: string
  creatorId: string
  onRepoint?: ((id: string) => void) | undefined
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const suggestions = useQuery({
    queryKey: ['kol-merge-suggestions', assignment],
    queryFn: () => getKolMergeSuggestions(assignment),
  })
  const [error, setError] = useState<string | undefined>(undefined)
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'accept' | 'reject'; keep: string }) =>
      decideKolMerge(v.id, v.decision, assignment),
    onSuccess: (_out, v) => {
      setError(undefined)
      void client.invalidateQueries({ queryKey: ['kol-merge-suggestions'] })
      void client.invalidateQueries({ queryKey: ['kol-creators'] })
      void client.invalidateQueries({ queryKey: ['kol-creator'] })
      if (v.decision === 'accept' && v.keep !== creatorId) onRepoint?.(v.keep)
    },
    onError: (e: unknown) => {
      setError(errorText(e, t('kol.info.identity.failed')))
    },
  })
  const mine = (suggestions.data?.rows ?? []).filter(
    (s) => s.keep.creator_id === creatorId || s.merge.creator_id === creatorId,
  )
  if (mine.length === 0) return null
  return (
    <div className="flex flex-col gap-2" data-testid="kol-identity-banner">
      {mine.map((s) => {
        const other = s.keep.creator_id === creatorId ? s.merge : s.keep
        return (
          <div
            key={s.id}
            className="flex flex-col gap-1.5 rounded-lg bg-ws-warn-bg px-3 py-2 text-xs text-ws-ink"
            data-slot="warning"
          >
            <span>
              {t('kol.info.identity.title', { name: other.display_name })}
              <span className="text-muted-foreground">
                {' · '}
                {s.reasons.map((r) => r.text.replace(/[。.]$/, '')).join('；')}
              </span>
            </span>
            <span className="flex gap-1.5">
              <Button
                size="xs"
                variant="outline"
                data-testid="kol-identity-merge"
                disabled={decide.isPending}
                onClick={() => {
                  decide.mutate({ id: s.id, decision: 'accept', keep: s.keep.creator_id })
                }}
              >
                {t('kol.info.identity.merge')}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                data-testid="kol-identity-reject"
                disabled={decide.isPending}
                onClick={() => {
                  decide.mutate({ id: s.id, decision: 'reject', keep: s.keep.creator_id })
                }}
              >
                {t('kol.info.identity.reject')}
              </Button>
            </span>
          </div>
        )
      })}
      <KolError error={error} testid="kol-identity-error" />
    </div>
  )
}

/* ── 存入红人池那一份资料：简介、加入时间这些（WP498） ──────────────────── */

/**
 * 简介（KOLAgents：三行收起 + 展开）与页面上那几个零碎事实（加入于 · 总播放 · 作品数 · 存入于）。
 * 头像 / 横幅只给链接：工坊的壳不加载外站图片。
 */
function SavedProfile({ profile: p }: { profile: KolCreatorProfileData }): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const facts = [
    p.joined_date === undefined ? undefined : t('kol.profile.joined', { at: p.joined_date }),
    p.total_views === undefined
      ? undefined
      : t('kol.profile.total_views', { n: formatCount(p.total_views) }),
    p.video_count === undefined ? undefined : t('kol.profile.videos', { n: String(p.video_count) }),
  ].filter((x): x is string => x !== undefined)
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="kol-saved-profile">
      {p.bio === undefined ? null : (
        <div className="flex flex-col items-start gap-0.5">
          <p
            className={cn(
              'whitespace-pre-wrap leading-relaxed text-muted-foreground',
              !open && 'line-clamp-3',
            )}
            data-testid="kol-profile-bio"
          >
            {p.bio}
          </p>
          {p.bio.length > 140 || p.bio.split('\n').length > 3 ? (
            <button
              type="button"
              className="text-xs text-ws-brand hover:underline"
              onClick={() => {
                setOpen((v) => !v)
              }}
            >
              {open ? t('kol.card.collapse') : t('kol.card.expand')}
            </button>
          ) : null}
        </div>
      )}
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground"
        data-slot="data"
      >
        {facts.length === 0 ? null : (
          <span data-testid="kol-profile-facts">{facts.join(' · ')}</span>
        )}
        <span>{t('kol.profile.saved_at', { at: dayOf(p.saved_at) })}</span>
        {/* WP502：缓存到本机的图已经画在头部 / 横幅上了；没缓存到的那张才给外站链接 */}
        {p.avatar_url === undefined || p.avatar_media_url !== undefined ? null : (
          <a className="underline" href={p.avatar_url} target="_blank" rel="noreferrer">
            {t('kol.profile.avatar')}
          </a>
        )}
        {p.banner_url === undefined || p.banner_media_url !== undefined ? null : (
          <a className="underline" href={p.banner_url} target="_blank" rel="noreferrer">
            {t('kol.profile.banner')}
          </a>
        )}
        {(p.avatar_url === undefined || p.avatar_media_url !== undefined) &&
        (p.banner_url === undefined || p.banner_media_url !== undefined) ? null : (
          <Hint text={t('kol.profile.images.hint')} testId="kol-profile-images-hint" />
        )}
      </div>
    </div>
  )
}

/* ── 合作历史（KOLAgents `RelationshipBadge` + `RelationshipHistory`） ─────── */

const OPEN_STAGES = new Set([
  'contacted',
  'replied',
  'negotiating',
  'agreed',
  'sample_sent',
  'delivering',
  'delivered',
])

/** 花了多少：批过的付款加起来（只算同一币种里最多的那一种，混币种不硬加）。 */
function spendOf(
  collabs: readonly KolCollaborationData[],
): { amount: number; currency: string } | undefined {
  const byCurrency = new Map<string, number>()
  for (const c of collabs)
    for (const p of c.payments ?? [])
      byCurrency.set(p.currency, (byCurrency.get(p.currency) ?? 0) + p.amount)
  const top = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]
  return top === undefined ? undefined : { currency: top[0], amount: top[1] }
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}

function RelationshipHistory({ collabs }: { collabs: readonly KolCollaborationData[] }): ReactNode {
  const { t } = useApp()
  const done = collabs.filter((c) => c.stage === 'closed' || c.stage === 'delivered').length
  const active = collabs.filter((c) => OPEN_STAGES.has(c.stage) && c.stage !== 'delivered').length
  const declined = collabs.filter((c) => c.stage === 'declined').length
  const last = collabs
    .map((c) => c.last_activity_at)
    .filter((x): x is string => x !== undefined)
    .sort()
    .at(-1)
  const spend = spendOf(collabs)
  const badge =
    active > 0 ? (
      <StatusPill tone="brand" data-testid="kol-relationship-badge">
        {t('kol.info.rel.active', { n: active })}
      </StatusPill>
    ) : done > 0 ? (
      <StatusPill tone="warn" data-testid="kol-relationship-badge">
        {t('kol.info.rel.past', { n: done })}
      </StatusPill>
    ) : null
  return (
    <Block testId="kol-history">
      <SectionHeading title={t('kol.detail.history')} action={badge} />
      <dl className="grid grid-cols-3 gap-3 text-sm" data-slot="data">
        <div>
          <dt className="text-xs text-muted-foreground">{t('kol.info.rel.count')}</dt>
          <dd className="ws-num font-medium">{collabs.length}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('kol.info.rel.last')}</dt>
          <dd className="ws-num font-medium">{dayOf(last)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('kol.info.rel.spend')}</dt>
          <dd className="ws-num font-medium">
            {spend === undefined ? '—' : money(spend.amount, spend.currency)}
          </dd>
        </div>
        {declined > 0 ? (
          <div className="col-span-3 text-xs text-muted-foreground">
            {t('kol.info.rel.declined', { n: declined })}
          </div>
        ) : null}
      </dl>
      {/* 老测试与脚本认的那一行：每条合作 渠道 · 阶段 */}
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-slot="data">
        {collabs.map((c) => (
          <li key={c.id}>
            {t(`kol.channel.${c.channel}`)} · {t(`kol.stage.${c.stage}`)}
            {c.budget === undefined ? '' : ` · ${money(c.budget, c.currency)}`}
          </li>
        ))}
      </ul>
    </Block>
  )
}

/* ── 单条合作参考价（KOLAgents `CreatorRateReference` 的位置；算法是插件那份估值） ── */

function RateReferenceSection({ checks }: { checks: KolCreatorChecksData }): ReactNode {
  const { t } = useApp()
  const v = checks.valuation
  if (v === undefined) return null
  return (
    <section className="flex flex-col gap-2" data-testid="kol-valuation">
      <SectionHeading
        title={t('kol.info.valuation')}
        badge={<EstimatedTag />}
        hint={t('kol.info.valuation.hint')}
      />
      {v.kind === 'estimated' ? (
        <div className="rounded-lg bg-muted/50 px-3 py-2" data-slot="data">
          <div className="ws-num text-lg font-semibold" data-testid="kol-valuation-range">
            {formatCents(v.low_cents)} – {formatCents(v.high_cents)}
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {t('kol.info.valuation.basis', {
              n: v.items_used,
              views: formatCount(v.median_views),
              mid: formatCents(v.mid_cents),
            })}
            {v.cap_applied ? <Hint text={t('kol.info.valuation.capped')} /> : null}
          </div>
        </div>
      ) : (
        <p
          className="text-xs text-muted-foreground"
          data-slot="status"
          data-testid="kol-valuation-none"
        >
          {v.reason === 'thin_views'
            ? t('kol.info.valuation.thin', { n: v.items_used ?? 0 })
            : v.reason === 'suspected_fake'
              ? t('kol.info.valuation.fake')
              : t('kol.info.valuation.unsupported')}
        </p>
      )}
    </section>
  )
}

/* ── 账号质量（KOLAgents `AccountQualitySection` + 受众真实性那一块） ───────── */

type QualityLevel = 'good' | 'normal' | 'warning'

const LEVEL_TONE: Record<QualityLevel, Tone> = { good: 'good', normal: 'neutral', warning: 'warn' }

function QualityRow({
  id,
  label,
  value,
  level,
  levelText,
  hint,
  warning,
}: {
  id: string
  label: string
  value: string
  level?: QualityLevel | undefined
  levelText?: string | undefined
  hint: string
  /** 要人别签这个人的那一句：永远看得见，不进问号。 */
  warning?: string | undefined
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-1"
      data-testid="kol-quality-row"
      data-metric={id}
      data-level={level}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium">
          {label}
          <Hint text={hint} />
        </span>
        <span className="flex items-center gap-2" data-slot="data">
          <span className="ws-num text-muted-foreground">{value}</span>
          {level === undefined || levelText === undefined ? null : (
            <StatusPill tone={LEVEL_TONE[level]}>{levelText}</StatusPill>
          )}
        </span>
      </div>
      {warning === undefined ? null : (
        <p className="text-xs text-ws-bad" data-slot="warning">
          {warning}
        </p>
      )}
    </div>
  )
}

function QualitySection({
  checks,
  audit,
}: {
  checks: KolCreatorChecksData | undefined
  audit: KolCreatorDetailData['audit']
}): ReactNode {
  const { t } = useApp()
  const c = checks ?? {}
  const rows: ReactNode[] = []
  if (c.health !== undefined) {
    const h = c.health
    const level: QualityLevel =
      h.verdict === 'excellent' ? 'good' : h.verdict === 'normal' ? 'normal' : 'warning'
    rows.push(
      <QualityRow
        key="ratio"
        id="views_to_followers"
        label={t('kol.info.q.ratio')}
        value={formatRatio(h.views_to_followers)}
        level={level}
        levelText={t(`kol.info.q.verdict.${h.verdict}`)}
        hint={t('kol.info.q.ratio.hint')}
        warning={
          h.bought_audience_suspected
            ? t('kol.info.q.ratio.fake')
            : h.verdict === 'weak'
              ? t('kol.info.q.ratio.weak')
              : undefined
        }
      />,
    )
  }
  if (c.like_rate !== undefined) {
    const l = c.like_rate
    rows.push(
      <QualityRow
        key="like"
        id="like_rate"
        label={t('kol.info.q.like')}
        value={t('kol.info.q.like.value', { rate: formatRatio(l.median), n: l.items })}
        level={l.level}
        levelText={t(`kol.info.q.level.${l.level}`)}
        hint={t('kol.info.q.like.hint')}
        warning={l.level === 'warning' ? t('kol.info.q.like.low') : undefined}
      />,
    )
  }
  if (c.regularity !== undefined) {
    const r = c.regularity
    rows.push(
      <QualityRow
        key="cadence"
        id="regularity"
        label={t('kol.info.q.cadence')}
        value={
          r.avg_interval_days === undefined
            ? '—'
            : t('kol.info.q.cadence.value', { n: r.avg_interval_days })
        }
        level={r.status === 'regular' ? 'good' : 'warning'}
        levelText={t(`kol.info.q.cadence.${r.status}`)}
        hint={t('kol.info.q.cadence.hint')}
      />,
    )
  }
  if (c.follower_trend !== undefined) {
    const f = c.follower_trend
    const sign = f.delta > 0 ? '+' : f.delta < 0 ? '-' : ''
    rows.push(
      <QualityRow
        key="trend"
        id="follower_trend"
        label={t('kol.info.q.trend', { n: f.days })}
        value={`${sign}${formatCount(Math.abs(f.delta))}（${f.percent > 0 ? '+' : ''}${f.percent}%）`}
        hint={t('kol.info.q.trend.hint')}
      />,
    )
  }
  if (rows.length === 0 && audit === undefined) return null
  return (
    <section className="flex flex-col gap-2" data-testid="kol-quality">
      <SectionHeading
        title={t('kol.info.quality')}
        badge={<EstimatedTag />}
        hint={t('kol.info.quality.hint')}
      />
      <div className="flex flex-col gap-2.5 rounded-lg border border-ws-line p-3">
        {audit === undefined ? null : (
          <div className="flex flex-col gap-1" data-testid="kol-audit-detail">
            <div className="flex items-baseline gap-1.5">
              <span className="ws-num text-2xl font-semibold">{Math.round(audit.health)}</span>
              <span className="text-xs text-muted-foreground">
                {t('kol.info.audit.suffix', { at: dayOf(audit.at) })}
              </span>
              <Hint text={t('kol.info.audit.hint')} />
            </div>
            {audit.findings.length === 0 ? null : (
              <ul
                className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-muted-foreground"
                data-slot="data"
              >
                {audit.findings.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {rows}
      </div>
    </section>
  )
}

/* ── 合作进度 + 依据（KOLAgents「管道阶段」那一格；依据是 WP489 读邮件判阶段的原话） ─── */

function ProgressSection({
  assignment,
  channel,
  collabs,
}: {
  assignment: string
  channel: KolChannelId
  collabs: readonly KolCollaborationData[]
}): ReactNode {
  const { t } = useApp()
  // 段与停留天数是合作清单那一份算的（同一个缓存）；别的渠道的合作没有，就只写阶段
  const list = useQuery({
    queryKey: ['kol-collaborations', assignment, channel],
    queryFn: () => getKolCollaborations({ channel }, assignment),
  })
  const rows = new Map((list.data?.rows ?? []).map((r) => [r.id, r]))
  const open = collabs.filter((c) => c.stage !== 'closed' && c.stage !== 'declined')
  if (open.length === 0) return null
  return (
    <Block testId="kol-progress-section">
      <SectionHeading title={t('kol.info.progress')} hint={t('kol.info.progress.hint')} />
      {open.map((c) => {
        const row = rows.get(c.id)
        const evidence = c.stage_evidence ?? []
        return (
          <div key={c.id} className="flex flex-col gap-1.5" data-testid="kol-progress-collab">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <BrandIcon provider={CHANNEL_SERVICE[c.channel]} size={14} />
              <StatusPill tone={row?.stalled === true ? 'warn' : 'brand'}>
                {t(`kol.stage.${c.stage}`)}
              </StatusPill>
              {row?.status === undefined ? null : (
                <span className="text-muted-foreground" data-slot="status">
                  {row.status.label}
                </span>
              )}
              {c.budget === undefined ? null : (
                <span className="ws-num text-muted-foreground">{money(c.budget, c.currency)}</span>
              )}
              {c.awaiting_approval === true ? (
                <CategoryTag outline>{t('kol.info.progress.awaiting')}</CategoryTag>
              ) : null}
            </div>
            {row?.segments === undefined || row.segments.length === 0 ? null : (
              <CollabProgress segments={row.segments} dwellDays={row.dwell_days} layout="stepper" />
            )}
            {c.sample === undefined ? null : (
              <p className="text-xs text-muted-foreground" data-slot="data">
                {t('kol.info.progress.sample', {
                  at: dayOf(c.sample.shipped_at),
                  to: c.sample.address_masked,
                })}
                {c.sample.carrier === undefined ? '' : ` · ${c.sample.carrier}`}
              </p>
            )}
            {evidence.length === 0 && c.import_note === undefined ? null : (
              <div
                className="flex flex-col gap-1 rounded-md bg-muted/50 px-2 py-1.5 text-xs"
                data-testid="kol-stage-evidence"
              >
                <span className="font-medium">
                  {c.stage_source === 'import'
                    ? t('kol.info.evidence.import')
                    : c.stage_source === 'mail'
                      ? t('kol.info.evidence.mail')
                      : t('kol.info.evidence.title')}
                </span>
                {evidence.slice(0, 3).map((e) => (
                  <span key={e.message_id} className="text-muted-foreground" data-slot="data">
                    {dayOf(e.at)} ·{' '}
                    {e.direction === 'in' ? t('kol.info.evidence.in') : t('kol.info.evidence.out')}{' '}
                    · 「{e.quote}」
                  </span>
                ))}
                {c.import_note === undefined ? null : (
                  <span className="text-muted-foreground" data-slot="data">
                    {c.import_note}
                  </span>
                )}
              </div>
            )}
          </div>
        )
      })}
    </Block>
  )
}

/* ── 联系方式（KOLAgents B4 联系人那一格；工坊只有脱敏形态） ──────────────── */

function ContactsSection({
  assignment,
  creatorId,
  contacts,
  profileUrl,
}: {
  assignment: string
  creatorId: string
  contacts: KolCreatorDetailData['contacts']
  profileUrl: string | undefined
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)
  /*
   * 66 断点 #6：失败照实说服务端那句话，邮箱留在框里；成功才清空。
   */
  const add = useMutation({
    mutationFn: () => addKolContact(creatorId, { kind: 'email', value: email }, assignment),
    onSuccess: (contact) => {
      setError(undefined)
      setReceipt(`加好了：${contact.masked}。现在可以起开发信了。`)
      setEmail('')
      void client.invalidateQueries({ queryKey: ['kol-creator', creatorId] })
      void client.invalidateQueries({ queryKey: ['kol-creators'] })
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这条联系方式没加上。'))
    },
  })
  return (
    <section className="flex flex-col gap-2" data-testid="kol-contacts">
      <SectionHeading title={t('kol.detail.contacts')} hint={t('kol.detail.contacts.note')} />
      {contacts.length === 0 ? (
        <p
          className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
          data-slot="status"
        >
          {t('kol.detail.contacts.empty')}
          {/* KOLAgents：一个都没取到时，免费的那条路是他自己的主页（简介 / 关于页常有） */}
          {profileUrl === undefined ? null : (
            <a
              className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
              href={profileUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="size-3" aria-hidden />
              {t('kol.info.contacts.open_profile')}
            </a>
          )}
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-slot="data">
          {contacts.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-2 text-xs"
              data-testid="kol-contact"
            >
              <span className="font-mono">{c.masked}</span>
              {c.verified_at === undefined ? (
                <CategoryTag outline>{t('kol.info.contacts.unverified')}</CategoryTag>
              ) : (
                <StatusPill tone="good">{t('kol.info.contacts.verified')}</StatusPill>
              )}
              <span className="text-muted-foreground">
                {/* WP141：没登记的来源不把 i18n 键印上屏 */}
                {tOr(t, `kol.contact.source.${c.source}`, t('kol.contact.source.other'))}
              </span>
            </li>
          ))}
        </ul>
      )}
      <KolError error={error} testid="kol-detail-error" />
      <KolReceipt text={receipt} testid="kol-detail-receipt" />
      <div className="flex items-center gap-2">
        <Input
          className="h-8 text-xs"
          value={email}
          type="email"
          placeholder="name@example.com"
          data-testid="kol-contact-input"
          onChange={(e) => {
            setEmail(e.target.value)
          }}
        />
        <Button
          size="xs"
          variant="outline"
          data-testid="kol-contact-save"
          disabled={email.trim() === '' || add.isPending}
          onClick={() => {
            add.mutate()
          }}
        >
          {t('kol.detail.contacts.add')}
        </Button>
      </div>
    </section>
  )
}

/* ── 开发信（KOLAgents `OutreachDraftSection`：在这里起草预览，批 / 发在卡片里） ── */

function OutreachSection({
  assignment,
  channel,
  creatorId,
  rejected = false,
}: {
  assignment: string
  channel: KolChannelId
  creatorId: string
  /** WP505（决策 1773 B）：人点过「淘汰」——起草按钮退成次要样式（还能用，只是不再是这一页的主按钮）。 */
  rejected?: boolean
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [product, setProduct] = useState('')
  /*
   * WP416（决策 531）：两格**预填**——存过的优先，没存过从品牌档案拿；改了的起草成功后记成品牌设置。
   */
  const [pitch, setPitch] = useState('')
  const defaults = useQuery({
    queryKey: ['kol-outreach-defaults', assignment],
    queryFn: () => getKolOutreachDefaults(assignment),
  })
  const prefilled = useRef(false)
  useEffect(() => {
    const d = defaults.data
    if (d === undefined || prefilled.current) return
    prefilled.current = true
    setPitch((p) => (p === '' ? d.brand_pitch : p))
    setProduct((p) => (p === '' ? d.product : p))
  }, [defaults.data])
  const [draft, setDraft] = useState<KolOutreachData | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)
  /*
   * 66 断点 #7：成功出卡、被拦下（`staged: false` + 一句人话）、这一跳没打通（异常）三种分开说。
   */
  const outreach = useMutation({
    mutationFn: () =>
      draftKolOutreach({ creator_id: creatorId, channel, product, brand_pitch: pitch }, assignment),
    onSuccess: (out) => {
      setError(undefined)
      setDraft(out)
      const d = defaults.data
      if (
        out.staged &&
        d !== undefined &&
        (d.brand_pitch !== pitch.trim() || d.product !== product.trim())
      )
        void saveKolOutreachDefaults(
          { brand_pitch: pitch.trim(), product: product.trim() },
          assignment,
        ).then(() => client.invalidateQueries({ queryKey: ['kol-outreach-defaults'] }))
      setReceipt(
        out.staged
          ? out.auto_approved === true
            ? '这封信已经排进出站队列。'
            : '起草好了，在卡片里等你批。批了才发。'
          : undefined,
      )
      void client.invalidateQueries({ queryKey: ['kol-collaborations'] })
      refreshCards(client)
    },
    onError: (e: unknown) => {
      setDraft(undefined)
      setReceipt(undefined)
      setError(errorText(e, '这封信没起草成。'))
    },
  })
  return (
    <section className="flex flex-col gap-2" data-testid="kol-outreach">
      <h4 className="flex items-center gap-1.5 text-sm font-medium" data-slot="title">
        <Mail className="size-3.5" aria-hidden />
        {t('kol.detail.outreach')}
      </h4>
      <div className="flex flex-col gap-1.5">
        <Input
          className="h-8 text-xs"
          value={pitch}
          placeholder={t('kol.detail.outreach.pitch')}
          aria-label={t('kol.detail.outreach.pitch')}
          data-testid="kol-outreach-pitch"
          onChange={(e) => {
            setPitch(e.target.value)
          }}
        />
        <Input
          className="h-8 text-xs"
          value={product}
          placeholder={t('kol.detail.outreach.product')}
          aria-label={t('kol.detail.outreach.product')}
          data-testid="kol-outreach-product"
          onChange={(e) => {
            setProduct(e.target.value)
          }}
        />
        {defaults.data?.source === 'brand_profile' ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="kol-outreach-prefilled"
            data-slot="status"
          >
            {t('kol.detail.outreach.prefilled')}
          </p>
        ) : null}
        {defaults.data?.mailbox_connected === false ? (
          <p
            className="flex flex-wrap items-center gap-1 text-xs text-ws-warn"
            data-testid="kol-outreach-no-mailbox"
            data-slot="warning"
          >
            {t('kol.detail.outreach.no_mailbox')}
            <Link to="/connections?service=imap_smtp" className="underline underline-offset-2">
              {t('kol.detail.outreach.connect_mailbox')}
            </Link>
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button
            size="xs"
            variant={rejected ? 'outline' : 'default'}
            data-testid="kol-outreach-go"
            disabled={product.trim() === '' || pitch.trim() === '' || outreach.isPending}
            onClick={() => {
              outreach.mutate()
            }}
          >
            {t('kol.detail.outreach.draft')}
          </Button>
        </div>
      </div>
      <KolError error={error} testid="kol-detail-error" />
      <KolReceipt text={receipt} testid="kol-detail-receipt" />
      {draft === undefined ? null : (
        <div className="rounded-md border border-ws-line p-2" data-testid="kol-outreach-draft">
          {draft.staged ? (
            <>
              <div className="text-xs font-medium">{draft.subject}</div>
              <Textarea className="mt-1 text-xs" readOnly rows={6} value={draft.body} />
              <p className="mt-1 text-xs text-muted-foreground" data-slot="status">
                {draft.auto_approved === true
                  ? t('kol.detail.outreach.auto')
                  : t('kol.detail.outreach.queued')}
                {' · '}
                {t('kol.detail.outreach.quota', { n: draft.quota.remaining, cap: draft.quota.cap })}
              </p>
              {draft.needs_mailbox === true ? (
                <p className="mt-1 text-xs text-ws-warn" data-slot="warning">
                  {t('kol.detail.outreach.no_mailbox')}
                </p>
              ) : null}
            </>
          ) : (
            // 禁承诺是 block 不是转人审：这一封根本没进队列，理由照实说
            <p className="text-xs text-destructive" data-testid="kol-outreach-blocked">
              {draft.message}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

/* ── 追踪链接 + 折扣码（KOLAgents W5 / W8；工坊只读，生成在合作线程里） ─────── */

function TrackedLinksSection({
  links,
}: {
  links: KolCreatorDetailData['tracked_links']
}): ReactNode {
  const { t } = useApp()
  if (links.length === 0) return null
  return (
    <section className="flex flex-col gap-2" data-testid="kol-links">
      <SectionHeading title={t('kol.info.links')} hint={t('kol.info.links.hint')} />
      <ul className="flex flex-col gap-1.5" data-slot="data">
        {links.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-2 text-xs">
            <Link2 className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <a
              className="min-w-0 max-w-[14rem] truncate font-medium hover:underline"
              href={l.url}
              target="_blank"
              rel="noreferrer"
            >
              {l.url.replace(/^https?:\/\//, '')}
            </a>
            {l.affiliate_code === undefined ? null : <CategoryTag>{l.affiliate_code}</CategoryTag>}
            <span className="ws-num text-muted-foreground">
              {t('kol.info.links.stats', {
                clicks: l.clicks,
                orders: l.orders,
                revenue: l.revenue,
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ── 交付物（KOLAgents `DeliverablesSection`，只读：验收在合作线程里出卡） ─────── */

const REVIEW_TONE: Record<string, Tone> = {
  pending: 'neutral',
  approved: 'good',
  changes_requested: 'warn',
  rejected: 'bad',
}

function DeliverablesSection({
  deliverables,
}: {
  deliverables: KolCreatorDetailData['deliverables']
}): ReactNode {
  const { t } = useApp()
  if (deliverables.length === 0) return null
  return (
    <section className="flex flex-col gap-2" data-testid="kol-deliverables">
      <SectionHeading title={t('kol.info.deliverables')} />
      <ul className="flex flex-col gap-1.5" data-slot="data">
        {deliverables.map((d) => (
          <li
            key={d.id}
            className="flex flex-wrap items-center gap-2 text-xs"
            data-testid="kol-deliverable"
          >
            <span className="font-medium">{tOr(t, `kol.info.kind.${d.kind}`, d.kind)}</span>
            <StatusPill tone={REVIEW_TONE[d.review] ?? 'neutral'}>
              {t(`kol.review.${d.review}`)}
            </StatusPill>
            <span className="ws-num text-muted-foreground">
              {t('kol.info.deliverables.due', { at: dayOf(d.due_at) })}
            </span>
            {d.url === undefined ? null : (
              <a
                className="inline-flex items-center gap-0.5 hover:underline"
                href={d.url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="size-3" aria-hidden />
                {t('kol.info.deliverables.open')}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ── 合作档案（KOLAgents `CollaborationArchiveSection`：谈完的那几次，一张一张） ── */

function ArchiveSection({
  collabs,
  deliverables,
}: {
  collabs: readonly KolCollaborationData[]
  deliverables: KolCreatorDetailData['deliverables']
}): ReactNode {
  const { t } = useApp()
  const done = collabs.filter((c) => c.stage === 'closed' || c.stage === 'declined')
  if (done.length === 0) return null
  return (
    <section className="flex flex-col gap-2" data-testid="kol-archive">
      <SectionHeading title={t('kol.info.archive')} hint={t('kol.info.archive.hint')} />
      <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
        {done.map((c) => {
          const mine = deliverables.filter((d) => d.collaboration_id === c.id)
          const paid = spendOf([c])
          const ok = c.stage === 'closed'
          return (
            <div
              key={c.id}
              className={cn(
                'flex flex-col gap-1 rounded-lg border border-ws-line p-2.5 text-xs',
                !ok && 'opacity-70',
              )}
              data-testid="kol-archive-card"
            >
              <span className="flex items-center gap-1.5">
                <BrandIcon provider={CHANNEL_SERVICE[c.channel]} size={14} />
                <StatusPill tone={ok ? 'good' : 'neutral'}>{t(`kol.stage.${c.stage}`)}</StatusPill>
                <span className="ws-num ml-auto text-muted-foreground">
                  {dayOf(c.agreed_at ?? c.last_activity_at)}
                </span>
              </span>
              <span className="ws-num text-muted-foreground" data-slot="data">
                {[
                  c.budget === undefined ? undefined : money(c.budget, c.currency),
                  paid === undefined
                    ? undefined
                    : t('kol.info.archive.paid', { amount: money(paid.amount, paid.currency) }),
                  mine.length === 0
                    ? undefined
                    : t('kol.info.archive.deliverables', {
                        n: mine.length,
                        ok: mine.filter((d) => d.review === 'approved').length,
                      }),
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </span>
              {c.import_note === undefined ? null : (
                <span className="line-clamp-2 text-muted-foreground">{c.import_note}</span>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/*
 * ── 近期作品（KOLAgents `RecentContentsSection`）────────────────────────
 * WP502：封面是存入时缓存到本机的（1760 B，没缓存到是色块）；点一下在浏览器里打开原作品（1764 B，
 * 没记下链接的那几条点不开）。
 */

function RecentWorks({
  accounts,
  profiles,
  assignment,
}: {
  accounts: readonly Account[]
  profiles: KolCreatorDetailData['profiles']
  assignment: string
}): ReactNode {
  const { t } = useApp()
  const multi =
    new Set(accounts.filter((a) => profiles?.[a.id] !== undefined).map((a) => a.channel)).size > 1
  const items = accounts.flatMap((a) =>
    (profiles?.[a.id]?.recent_items ?? []).map((r, i) => ({
      ...r,
      channel: a.channel,
      key: `${a.id}-${String(i)}`,
    })),
  )
  if (items.length === 0) return null
  const shown = items.slice(0, 6)
  return (
    <section className="flex flex-col gap-2" data-testid="kol-profile-recent">
      <SectionHeading title={t('kol.profile.recent')} hint={t('kol.info.recent.hint')} />
      <ul className="grid grid-cols-2 gap-2">
        {shown.map((r) => {
          const body = (
            <>
              <WorkCover mediaUrl={r.thumbnail_media_url} assignment={assignment}>
                {multi ? <BrandIcon provider={CHANNEL_SERVICE[r.channel]} size={12} /> : undefined}
              </WorkCover>
              {/* min-w-0 + line-clamp（KOLAgents：truncate 的子元素会把整栏撑宽） */}
              <span className="line-clamp-2 min-w-0 text-xs font-medium leading-snug">
                {r.title}
              </span>
              <span
                className="ws-num flex min-w-0 flex-wrap gap-x-2 text-[11px] text-muted-foreground"
                data-slot="data"
              >
                {[
                  r.views_text ??
                    (r.views === undefined
                      ? undefined
                      : t('kol.info.recent.views', { n: formatCount(r.views) })),
                  r.likes === undefined
                    ? undefined
                    : t('kol.info.recent.likes', { n: formatCount(r.likes) }),
                  r.comments === undefined
                    ? undefined
                    : t('kol.info.recent.comments', { n: formatCount(r.comments) }),
                  r.published_text,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </>
          )
          return (
            <li key={r.key} className="min-w-0" data-testid="kol-recent-item">
              {r.url === undefined || !r.url.startsWith('https://') ? (
                <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-ws-line p-1.5">
                  {body}
                </div>
              ) : (
                <a
                  className="group flex min-w-0 flex-col gap-1.5 rounded-lg border border-ws-line p-1.5 transition-colors hover:border-primary/40"
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  title={t('kol.recent.open')}
                  data-testid="kol-recent-open"
                >
                  {body}
                </a>
              )}
            </li>
          )
        })}
      </ul>
      {items.length > shown.length ? (
        <span className="text-xs text-muted-foreground">
          {t('kol.profile.more', { n: String(items.length - shown.length) })}
        </span>
      ) : null}
    </section>
  )
}

/* ── 整张卡 ───────────────────────────────────────────────────────────── */

export function CreatorInfoCard({
  view,
  assignment,
  channel,
  onRepoint,
}: {
  view: KolCreatorDetailData
  assignment: string
  /** 这一屏是从哪条渠道职责开的（起开发信、读合作进度用这条）。 */
  channel: KolChannelId
  /** 合并之后保留的是另一条：把详情转过去。 */
  onRepoint?: ((creator_id: string) => void) | undefined
}): ReactNode {
  const { t } = useApp()
  const accounts = personAccounts(view.accounts)
  const primary = accounts[0]
  const profile = primary === undefined ? undefined : view.profiles?.[primary.id]
  const score = primary === undefined ? undefined : view.scores?.[primary.id]
  const checks = primary === undefined ? undefined : view.checks?.[primary.id]
  const multi = accounts.length > 1
  // 结论那一格：护栏那一句 > 最弱的那一项（低于 45 才说）
  const weakest = score?.factors.filter((f) => f.score < 45).sort((a, b) => a.score - b.score)[0]
  const savedProfiles = accounts.filter((a) => view.profiles?.[a.id] !== undefined)

  return (
    <div
      className="@container flex flex-col gap-5"
      data-testid="kol-creator-detail"
      data-creator={view.creator.id}
    >
      {/* 横幅（KOLAgents W31：认出是不是要找的那个频道最快的一眼；没缓存到整条不画） */}
      <CreatorBanner mediaUrl={profile?.banner_media_url} assignment={assignment} />

      <IdentityBanner assignment={assignment} creatorId={view.creator.id} onRepoint={onRepoint} />

      {/* 头部：谁 · 哪个平台（链到他的主页）· 在哪 */}
      <header className="flex items-start gap-3">
        <CreatorAvatar
          id={view.creator.id}
          name={view.creator.display_name}
          mediaUrl={profile?.avatar_media_url}
          assignment={assignment}
          className="size-12 text-base"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              className="text-lg font-semibold leading-tight text-ws-ink"
              data-slot="title"
              data-testid="kol-detail-name"
            >
              {view.creator.display_name}
            </h3>
            <ReviewBadge review={view.review} showPending />
            {score?.blocked === undefined ? null : (
              <StatusPill tone="bad" data-testid="kol-detail-blocked-badge">
                {t('kol.info.blocked')}
              </StatusPill>
            )}
          </div>
          {primary === undefined ? null : (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <a
                className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline"
                href={primary.url}
                target="_blank"
                rel="noreferrer"
                data-testid="kol-detail-handle"
              >
                <BrandIcon provider={CHANNEL_SERVICE[primary.channel]} size={14} />
                <span className="truncate">
                  {atHandle(primary.handle)}
                  {primary.category === undefined ? '' : ` · ${primary.category}`}
                </span>
                <ExternalLink className="size-3.5 shrink-0" aria-hidden />
              </a>
              <CreatorCountry region={primary.region} country={profile?.country} />
            </div>
          )}
        </div>
      </header>

      {/* 数字：一个账号 = 三格；两个以上 = 分平台表（一条三格说不清两份受众） */}
      <section data-testid="kol-accounts" className="flex flex-col gap-1.5">
        {multi ? (
          <CreatorPlatformBreakdown
            accounts={accounts}
            primaryId={primary?.id}
            profiles={view.profiles}
          />
        ) : primary === undefined ? null : (
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 px-3 py-2" data-slot="data">
            <Figure label={t('kol.judge.followers')} value={formatCount(primary.followers)} />
            <Figure label={t('kol.info.avg_views')} value={formatCount(avgViewsOf(profile))} />
            <Figure
              label={t('kol.info.engagement')}
              value={formatEngagementRate(primary.engagement_rate)}
            />
          </div>
        )}
        {/* `observed_at` 一定露在外面——半年前的粉丝数拿来打分，与编一个数没区别 */}
        {primary === undefined ? null : (
          <span
            className="text-xs text-muted-foreground"
            data-testid="kol-observed-at"
            data-slot="status"
          >
            {t('kol.observed_at', { at: dayOf(primary.observed_at) })}
          </span>
        )}
      </section>

      {/* 评估结论：人点开就是来看它的，紧跟数字（KOLAgents 08-06「太奇怪了」那一次挪上来的） */}
      {score === undefined ? null : (
        <section
          className={cn(
            'flex flex-col gap-1.5 rounded-lg border p-3',
            score.blocked === undefined ? 'border-ws-line' : 'border-ws-bad/40',
          )}
          data-testid="kol-verdict"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium" data-slot="title">
              {t('kol.info.verdict')}
            </h4>
            {score.blocked === undefined ? (
              <StatusPill tone={scoreTone(score.total)}>
                {t(
                  score.total >= 80
                    ? 'kol.info.verdict.good'
                    : score.total >= 68
                      ? 'kol.info.verdict.ok'
                      : 'kol.info.verdict.weak',
                )}
              </StatusPill>
            ) : null}
            <span className="ws-num text-xs text-muted-foreground">
              {t('kol.info.verdict.score', { n: score.total })}
            </span>
          </div>
          {score.blocked !== undefined ? (
            <p
              className="flex items-start gap-1 text-xs leading-relaxed text-ws-bad"
              data-slot="warning"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {score.blocked}
            </p>
          ) : weakest !== undefined ? (
            <p className="text-xs leading-relaxed text-muted-foreground" data-slot="status">
              {weakest.label}：{weakest.why}
            </p>
          ) : null}
        </section>
      )}

      {/* 他自己怎么介绍自己（WP498 存入红人池时记下的；只有存过的账号有） */}
      {savedProfiles.map((a) => (
        <div key={a.id} className="flex flex-col gap-1">
          {multi ? (
            <span className="flex items-center gap-1 text-xs font-medium">
              <BrandIcon provider={CHANNEL_SERVICE[a.channel]} size={12} />
              {atHandle(a.handle)}
            </span>
          ) : null}
          <SavedProfile profile={view.profiles?.[a.id] as KolCreatorProfileData} />
        </div>
      ))}

      {view.collaborations.length === 0 ? null : (
        <RelationshipHistory collabs={view.collaborations} />
      )}

      {/* 标签（KOLAgents 放在合作历史那一格里）：人自己的归类词，能动手的地方，空着也在 */}
      <section className="flex flex-col gap-1.5" data-testid="kol-tags-section">
        <SectionHeading title={t('kol.tags.title')} />
        <CreatorTagsPanel
          assignment={assignment}
          creatorId={view.creator.id}
          tags={view.tags ?? []}
        />
      </section>

      {checks === undefined ? null : <RateReferenceSection checks={checks} />}

      <QualitySection checks={checks} audit={view.audit} />

      {/* 分项分（KOLAgents「Score」那一格：总分 + 每项一条，理由进问号） */}
      {score === undefined ? null : (
        <Block testId="kol-score">
          <div className="flex items-baseline gap-1">
            <span className="ws-num text-3xl font-semibold">{score.total}</span>
            <span className="text-sm text-muted-foreground">{t('kol.info.score.suffix')}</span>
            <Hint text={t('kol.info.score.hint')} />
          </div>
          <div className="flex flex-col gap-1.5">
            {score.factors.map((f) => (
              <ScoreBar key={f.id} label={f.label} value={f.score} why={f.why} />
            ))}
          </div>
        </Block>
      )}

      <ProgressSection assignment={assignment} channel={channel} collabs={view.collaborations} />

      {/* 审核决定紧跟合作进度（KOLAgents：同一个动作的两种粒度——值不值得谈 / 谈到哪了） */}
      <ReviewSection assignment={assignment} view={view} />

      <ContactsSection
        assignment={assignment}
        creatorId={view.creator.id}
        contacts={view.contacts}
        profileUrl={primary?.url}
      />

      <OutreachSection
        assignment={assignment}
        channel={channel}
        creatorId={view.creator.id}
        rejected={view.review?.decision === 'rejected'}
      />

      <TrackedLinksSection links={view.tracked_links} />

      <DeliverablesSection deliverables={view.deliverables} />

      <ArchiveSection collabs={view.collaborations} deliverables={view.deliverables} />

      <RecentWorks accounts={accounts} profiles={view.profiles} assignment={assignment} />
    </div>
  )
}
