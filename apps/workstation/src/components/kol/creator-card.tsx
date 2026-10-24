/**
 * 候选池的达人卡（WP302，决策 406 第一期）。
 *
 * 移植自 KOLAgents（Luoye 的产品，非模板代码）：`src/components/influencer/views/creators-view.tsx`
 * @ 88d74b2c 的 `ScoreHero` / `Stat` / 判断色块配色 / 「按阶段变的下一步」——一屏六张卡时，
 * 人不该每张都要自己推一遍「这人现在在哪一步、所以我该干什么」，按钮直接说。
 *
 * 改的地方：
 * - 第三格 KOLAgents 是「均播」，工坊没有均播数据，换成「品类」：格子里写他做什么，色块按打分里
 *   「品类」那一项（决策 405：五个确定性分项是底，这里只拿来上色，不另编数；没判的不上色）；
 * - 下一步按工坊的十段阶段机（决策 404）；点了只是**打开**（详情里起草开发信 → 出卡；
 *   线程里推进），卡上不替人做决定（docs/96 P1）；
 * - 颜色换成 `--ws-*` 令牌，`Tooltip` 换成工坊的。
 *
 * WP500（决策 1758）再照 KOLAgents 那张卡补齐身份那一行与底下那一排：
 * - 头像（一个字的圆头像——壳不加载外站图片，见决策 1762）+ 名字 + 平台标志 · @handle（`creators-view.tsx` 的 identity 行）；
 * - 底下左边是联系方式那一格（KOLAgents `CardEmailSlot` 的「有 / 没有」两态：有 = 一个安静的信封，
 *   没有 = 灰的；工坊没有「付费取邮箱」那一态的按钮，取邮箱在详情里）和「打开他的主页」，右边是下一步。
 *   主页链接放在底下而不是 handle 上：上半张卡整块是「点开详情」的按钮，按钮里不能再套链接。
 * - 三格判断色块（KOLAgents §3「这一条不能砍」）在一行三张卡的宽度（约 300px）下也出：窄到 18rem 以下才退成一行字
 *   （WP416 原来是 20rem，桌面一行三张时三格全退成了一行字）。
 *
 * WP502：头像换成存入时缓存到本机的那张（决策 1760 B，没缓存到照旧一个字）；名字下面一行是人自己打的标签
 * （前 3 个 + 「+N」，一行锁死——KOLAgents「Operator labels」那一行），底下一排补「已通过 / 已淘汰」（1763 B；
 * 待审不画，只把定过的那几个标出来）。
 */
import { ExternalLink, Mail, MailX } from 'lucide-react'
import type { ReactNode } from 'react'
import { BrandIcon } from '@/components/brand-icons'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { KolCreatorRowData, KolJudgementLevel } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { CreatorAvatar } from './creator-media'
import { ReviewBadge } from './creator-review'
import { CHANNEL_SERVICE } from './kol-channel'
import { CollabProgress } from './segmented-progress'

/** 绿只是轻轻一层，黄说出来，红大声说（KOLAgents 的同一级差）。 */
const JUDGEMENT_BADGE: Record<KolJudgementLevel, string> = {
  good: 'bg-ws-good-bg text-ws-good',
  warn: 'bg-ws-warn-bg text-ws-warn',
  bad: 'bg-ws-bad text-background',
}

/** 格子底色：好的不上色。 */
const JUDGEMENT_CELL: Record<KolJudgementLevel, string> = {
  good: '',
  warn: 'bg-ws-warn-bg',
  bad: 'bg-ws-bad-bg',
}

/** 分项分 → 三档：≥70 好、40–69 一般、<40 弱。 */
export function levelOfFactor(score: number | undefined): KolJudgementLevel | undefined {
  if (score === undefined) return undefined
  return score >= 70 ? 'good' : score >= 40 ? 'warn' : 'bad'
}

export type NextStep =
  | 'draft'
  | 'thread'
  | 'negotiate'
  | 'sample'
  | 'deliver'
  | 'review'
  | 'blocked'
  | 'view'

const NEXT_BY_STAGE: Readonly<Record<string, NextStep>> = {
  sourced: 'draft',
  contacted: 'thread',
  replied: 'negotiate',
  negotiating: 'negotiate',
  agreed: 'sample',
  sample_sent: 'deliver',
  delivering: 'deliver',
  delivered: 'review',
  closed: 'view',
  declined: 'view',
}

/** 这张卡的主按钮。数不可信的先人工看；还没合作的起草开发信。 */
export function nextStepOf(row: Pick<KolCreatorRowData, 'blocked' | 'collab'>): NextStep {
  if (row.blocked !== undefined) return 'blocked'
  if (row.collab === undefined) return 'draft'
  return NEXT_BY_STAGE[row.collab.stage] ?? 'view'
}

/** 下一步落在哪：开发信 / 人工看 / 看看在详情里，其余在合作线程里。 */
export function stepOpensThread(step: NextStep): boolean {
  return step !== 'draft' && step !== 'blocked' && step !== 'view'
}

const num = (n: number | undefined): string =>
  n === undefined
    ? '—'
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 10_000
        ? `${Math.round(n / 1000)}k`
        : String(n)

/** 大号分数（KOLAgents `ScoreHero`）：≥80 主色、68–79 墨色、其余灰。 */
function ScoreHero({ score, label }: { score: number | undefined; label: string }): ReactNode {
  return (
    <span className="w-11 shrink-0 text-center" data-testid="kol-card-score">
      <span
        className={cn(
          'ws-num block text-[22px] font-extrabold leading-none tracking-tight',
          score === undefined
            ? 'text-muted-foreground'
            : score >= 80
              ? 'text-primary'
              : score >= 68
                ? 'text-foreground'
                : 'text-muted-foreground',
        )}
      >
        {score ?? '—'}
      </span>
      <span className="mt-0.5 block text-xs font-semibold tracking-wide text-muted-foreground">
        {label}
      </span>
    </span>
  )
}

/** 指标条上的一格：数字永远不截断，判断色块可以截（全句在悬停里）。 */
function Stat({
  id,
  label,
  value,
  level,
  badge,
  reason,
  textual = false,
}: {
  id: string
  label: string
  value: string
  level?: KolJudgementLevel | undefined
  badge?: string | undefined
  reason?: string | undefined
  /** 值是一个词（品类名）不是数：可以截断，色块不截。 */
  textual?: boolean
}): ReactNode {
  const body = (
    <span
      className={cn(
        'block min-w-0 rounded-sm px-2 py-1.5 text-left',
        level === undefined ? '' : JUDGEMENT_CELL[level],
      )}
      data-testid="kol-card-stat"
      data-stat={id}
      data-level={level}
    >
      <span className="block truncate text-xs leading-tight text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-baseline gap-1">
        <span
          className={cn('text-sm font-medium', textual ? 'min-w-0 truncate' : 'ws-num shrink-0')}
        >
          {value}
        </span>
        {badge === undefined || level === undefined ? null : (
          <span
            className={cn(
              // 色块只有一两个字（好 / 一般 / 弱），不截——截成「…」就白画了
              'shrink-0 rounded-sm px-1 text-xs font-bold leading-[1.35]',
              JUDGEMENT_BADGE[level],
            )}
          >
            {badge}
          </span>
        )}
      </span>
    </span>
  )
  if (reason === undefined) return body
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block min-w-0" title={reason}>
            {body}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function CreatorCard({
  row,
  handle,
  assignment,
  onOpen,
  onNext,
  as: Tag = 'li',
  leading,
}: {
  row: KolCreatorRowData
  /** 取本机缓存的头像要带的分配（不给就用当前那条）。 */
  assignment?: string
  /** 显示用的 `@handle`（调用方统一过 `@`）。 */
  handle: string
  /** 点卡：打开详情。 */
  onOpen: () => void
  /** 点主按钮。 */
  onNext: (step: NextStep) => void
  /** WP504：在库面板里外面已经有一层 `<li>`（`LibraryItemFrame`），这里画成 `div`。 */
  as?: 'li' | 'div'
  /** WP504：名字前面那一格（多选时的勾）。 */
  leading?: ReactNode
}): ReactNode {
  const { t } = useApp()
  const step = nextStepOf(row)
  const eng = row.engagement_judgement
  const cat = row.factors?.find((f) => f.id === 'category')
  // 格子里写他做什么（「数码」）；没判的（没限类目 / 认不出）不画色块——中间分不是结论
  const catLevel = cat === undefined || cat.unknown === true ? undefined : levelOfFactor(cat.score)
  return (
    <Tag
      // WP416（自查 kol U1）：卡在窄的右栏里时（容器查询）只出一行「粉丝 · 互动」，三格数字不挤成一团
      className="@container relative flex min-w-0 flex-col gap-2 rounded-[var(--ws-radius-card)] border bg-card p-2.5"
      data-testid="kol-creator-card"
      data-creator={row.creator_id}
      data-next={step}
    >
      {/* WP504：多选时的勾放在卡左上角（不能套在下面那个按钮里） */}
      {leading == null ? null : (
        <span className="absolute top-3.5 left-3 z-10 flex">{leading}</span>
      )}
      <button
        type="button"
        className="flex min-w-0 flex-col gap-2 rounded-sm text-left hover:bg-muted/50"
        data-testid="kol-library-row"
        data-creator={row.creator_id}
        onClick={onOpen}
      >
        <span className={cn('flex min-w-0 items-start gap-2', leading != null && 'pl-6')}>
          <CreatorAvatar
            id={row.creator_id}
            name={row.display_name}
            mediaUrl={row.avatar_media_url}
            assignment={assignment}
            className="size-9 shrink-0 text-sm"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{row.display_name}</span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <BrandIcon provider={CHANNEL_SERVICE[row.channel]} size={12} className="shrink-0" />
              <span className="truncate">{handle}</span>
            </span>
          </span>
          {/* 刷粉护栏那一条：数不可信的不给分，理由写在卡上（名字下面整行，不再压在分数那一格里） */}
          {row.blocked === undefined ? (
            <ScoreHero score={row.score} label={t('kol.card.score')} />
          ) : null}
        </span>
        {row.blocked === undefined ? null : (
          <span className="text-xs leading-snug text-ws-bad" data-testid="kol-blocked">
            {row.blocked}
          </span>
        )}
        {/* 人自己打的标签：一行锁死，前 3 个 + 「+N」（全的在详情里） */}
        {(row.tags ?? []).length === 0 ? null : (
          <span
            className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden"
            data-testid="kol-card-tags"
          >
            {(row.tags ?? []).slice(0, 3).map((tag) => (
              <span
                key={tag}
                title={tag}
                className="min-w-0 shrink truncate rounded-full bg-muted px-1.5 text-xs leading-[1.5]"
                data-testid="kol-card-tag"
              >
                {tag}
              </span>
            ))}
            {(row.tags ?? []).length > 3 ? (
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                {t('kol.tags.more', { n: (row.tags ?? []).length - 3 })}
              </span>
            ) : null}
          </span>
        )}
        <span
          className="flex min-w-0 gap-2 truncate text-xs text-muted-foreground @[18rem]:hidden"
          data-testid="kol-card-compact"
        >
          <span className="ws-num">
            {t('kol.judge.followers')} {num(row.followers)}
          </span>
          {eng === undefined ? null : (
            <span className="ws-num">
              {t('kol.judge.engagement')} {eng.value}%
            </span>
          )}
        </span>
        <span className="hidden grid-cols-3 gap-1 @[18rem]:grid">
          <Stat id="followers" label={t('kol.judge.followers')} value={num(row.followers)} />
          <Stat
            id="engagement"
            label={t('kol.judge.engagement')}
            value={eng === undefined ? '—' : `${eng.value}%`}
            level={eng?.level}
            badge={eng === undefined ? undefined : t(`kol.judge.${eng.level}`)}
            reason={
              eng === undefined
                ? undefined
                : t('kol.judge.engagement.reason', { value: eng.value, median: eng.median })
            }
          />
          <Stat
            id="category"
            label={t('kol.judge.category')}
            value={row.category ?? '—'}
            textual
            level={catLevel}
            badge={catLevel === undefined ? undefined : t(`kol.judge.${catLevel}`)}
            reason={cat?.why}
          />
        </span>
      </button>
      {/* 迷你进度条：合作真动起来了才出（docs/96 P3）——「已找到」那一格人人都一样，画了是噪声 */}
      {row.collab === undefined || row.collab.stage === 'sourced' ? null : (
        <CollabProgress segments={row.collab.segments} dwellDays={row.collab.dwell_days} />
      )}
      <span className="flex items-center gap-1.5 border-t border-ws-line pt-2">
        {/* KOLAgents `CardEmailSlot`：联系方式是一个动作的位置，不是一枚红色「无邮箱」标签 */}
        <span
          className={cn(
            'inline-flex size-6 items-center justify-center rounded-md',
            row.has_contact ? 'text-muted-foreground' : 'text-muted-foreground/50',
          )}
          title={row.has_contact ? t('kol.card.email.has') : t('kol.card.email.none')}
          data-testid="kol-card-email"
          data-has={row.has_contact ? 'yes' : 'no'}
        >
          {row.has_contact ? (
            <Mail className="size-3.5" aria-label={t('kol.card.email.has')} />
          ) : (
            <MailX className="size-3.5" aria-label={t('kol.card.email.none')} />
          )}
        </span>
        <a
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          href={row.url}
          target="_blank"
          rel="noreferrer"
          title={t('kol.card.open_profile')}
          aria-label={t('kol.card.open_profile')}
          data-testid="kol-card-profile"
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
        {/* WP504（1777 A）：在一张还没定的批量开发信卡上——标「等你确认」 */}
        {row.awaiting_confirm === true ? (
          <span
            className="inline-flex h-5 items-center gap-1 rounded-full bg-ws-warn-bg px-1.5 text-xs font-medium text-ws-warn"
            data-testid="kol-card-awaiting"
          >
            <i aria-hidden className="size-1.5 rounded-full bg-ws-warn" />
            {t('library.awaiting')}
          </span>
        ) : null}
        {/* WP502：定过的才标（通过 / 淘汰）；理由在悬停里 */}
        {row.review === undefined ? null : (
          <span title={row.review.reason} className="inline-flex">
            <ReviewBadge review={row.review} />
          </span>
        )}
        {/* WP131：自动评分跑过的体检概括数（有才显示） */}
        {row.audit_health === undefined ? null : (
          <span className="text-xs text-muted-foreground" data-testid="kol-audit">
            {t('kol.audit', { n: row.audit_health })}
          </span>
        )}
        <span className="flex-1" />
        <Button
          size="xs"
          variant={step === 'draft' ? 'default' : 'outline'}
          data-testid="kol-card-next"
          data-next={step}
          onClick={() => {
            onNext(step)
          }}
        >
          {t(`kol.card.next.${step}`)}
        </Button>
      </span>
    </Tag>
  )
}
