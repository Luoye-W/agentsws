/**
 * WP96：卡的**主体**按 `card.layout` 换排版（十一种，09-18 设计画布《卡片排版一览》）。
 *
 * 分工（画布上那句"头一行、按钮行全类共用"）：
 * - 通用头（岗位 · 类 胶囊 / 等待时长 / 提案人头像）、通用页脚（按钮行 + 右下 → 圆钮）
 *   在 `deck-card.tsx` 里，全类一份；
 * - 这个文件只管中间那一块，十一个分支，**一个 kind 都不 switch**——它只看 layout，
 *   而 layout 是服务端投影时算好一起下发的（`@agentsws/deck` 的 layout.ts）。
 *
 * 纪律照旧：这里只**排版**，不算数也不编。payload 里没有的字段就不出那一格，
 * 绝不用"—"以外的东西填空（14 §2 数字不经模型手）。
 */
import { isAssistantNotesPayload, isFollowUpNudgePayload } from '@agentsws/contracts'
import type { DeckCard, DeckContentMode } from '@agentsws/deck'
import { pickContent } from '@agentsws/deck'
import { ExternalLink } from 'lucide-react'
import { useId } from 'react'
import { AdsChangeBody, isAdsChangePayload } from '@/components/ads/ads-change-body'
import { AdsSheetBody, isAdsSheetPayload } from '@/components/ads/ads-sheet-body'
import { CompanyNoticeExtras } from '@/components/company/company-mode'
import { openExternal } from '@/components/connections/bridge'
import { DigestCardBody } from '@/components/content-updates/digest-card-body'
import {
  isKolOutreachBatchPayload,
  isKolOutreachPayload,
  isKolReviewPayload,
  KolOutreachBatchBody,
  KolOutreachBody,
  KolReviewBody,
} from '@/components/kol/kol-card-bodies'
import { isKolMailMatchPayload, KolMailMatchBody } from '@/components/kol/kol-mail-match-body'
import { isKolSyncPayload, KolSyncBody } from '@/components/kol/kol-sync-body'
import { FollowUpCardBody } from '@/components/messages/follow-up-card-body'
import { isMessageRuleCardPayload, MessageRuleCardBody } from '@/components/messages/rule-card-body'
import {
  GoogleAlertChangeBody,
  isGoogleAlertChangePayload,
} from '@/components/pr/google-alert-change-body'
import { GeoWatchCardBody, isGeoWatchPayload } from '@/components/seo/geo-watch-card-body'
import { SetupDeckBody } from '@/components/setup/setup-deck-body'
import { isModerationPayload, ModerationCardBody } from '@/components/social/moderation-card-body'
import { isOwnSubPayload, OwnSubCardBody } from '@/components/social/own-sub-card-body'
import { isRedditWritePayload, RedditWriteBody } from '@/components/social/reddit-write-body'
import { Button } from '@/components/ui/button'
import { isServiceCard, ServiceCardBody } from '@/components/workshop-services/service-card-body'
import { useApp } from '@/lib/app-context'
import { isContentDigestPayload } from '@/lib/content-digest-api'
import { channelLabel, fieldLabel, fieldValue, tOr } from '@/lib/humanize'
import type { Lang } from '@/lib/i18n'
import { useMode } from '@/lib/mode'
import { AssistantNotesBody } from './assistant-notes-body'
import {
  FaqBatchBody,
  FaqImportBody,
  isFaqBatchPayload,
  isFaqImportPayload,
} from './faq-import-body'
import {
  isKnowledgeLearnedBody,
  isKnowledgeStaleBody,
  KnowledgeLearnedBody,
  KnowledgeStaleBody,
} from './knowledge-learned-body'
import { isKnowledgeToggleBody, KnowledgeToggleBody } from './knowledge-toggle-body'
import { isReport, ReportBody } from './report-body'
import { isThemeChoicePayload, ThemeChoiceBody } from './theme-choice-body'
import { isWeeklyReview, WeeklyReviewBody } from './weekly-review-body'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 把 payload 里的一个值压成一行人看得懂的字；对象就 JSON，别硬编成句子。 */
function valueText(v: unknown): string {
  if (v === undefined || v === null) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/**
 * payload 里的 before / after 摊成键值对；不是对象就当成单个值。
 *
 * WP141：键与值都过 `lib/humanize`——卡面上不再出现 `late_return_grace_days: 0 → 7`，
 * 而是「过了退货期还能宽限: 0 天 → 7 天」。
 */
function pairs(v: unknown, lang: Lang): [string, string][] {
  // WP261：`_` 开头的是给执行器用的（店铺、id、原样的菜单项…），不上卡面
  if (isRecord(v))
    return Object.entries(v)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, x]) => [fieldLabel(k, lang), fieldValue(k, x, lang)])
  if (v === undefined) return []
  return [['', valueText(v)]]
}

function highlightText(card: DeckCard, type: string): string | undefined {
  return card.highlights.find((h) => h.type === type)?.text
}

/** 灰底的一段话（依据 / 正文 / 原话都用它）。 */
function Note({
  children,
  testId,
}: {
  children: React.ReactNode
  testId?: string
}): React.ReactNode {
  // WP275（界面少字）：没有话就不出这个框
  if (children === '' || children === null || children === undefined) return null
  return (
    <p
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className="rounded-lg bg-ws-surface p-3 text-sm leading-6 whitespace-pre-wrap text-ws-body"
    >
      {children}
    </p>
  )
}

/**
 * 规范自检那一行（71 §5，WP122）：这批产出物有哪些地方不合这个品牌的
 * `DESIGN.md`（色板外的颜色、字体表外的字体……）。
 *
 * 排版上刻意做成**一行灰字**：不是红章、不是警告框、更不是按钮上的一把锁。
 * 这一行没有任何一条通路能让这张卡批不下去——品牌规范是给人省事的，
 * 一个会拦住人的检查，人只会想办法关掉它。
 */
function DesignNoteLine({ card }: { card: DeckCard }): React.ReactNode {
  const note = highlightText(card, 'design_note')
  if (note === undefined) return null
  return (
    <p className="mt-1.5 text-xs text-ws-muted-fg" data-testid="deck-design-note">
      {note}
    </p>
  )
}

/** 键值对表（金钱卡右半、事后决定卡、策略卡都用它）。 */
function KeyValues({
  rows,
  testId,
}: {
  rows: [string, string][]
  testId: string
}): React.ReactNode {
  if (rows.length === 0) return null
  return (
    <dl
      data-testid={testId}
      className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-[13px]"
    >
      {rows.map(([k, v]) => (
        <div key={`${k}:${v}`} className="col-span-2 grid grid-cols-subgrid">
          <dt className="text-ws-muted-fg">{k === '' ? '值' : k}</dt>
          <dd className="ws-num truncate text-right">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * WP418（审计 U9）：发布主题卡的主体——「打开预览」按钮（在浏览器里开）+ 换哪一份 + 改了几个文件。
 * 全从 payload 的 before / after 取；取不到主题名就退回整段说明。
 */
function PublishThemeBody({
  card,
  payload,
  fallback,
}: {
  card: DeckCard
  payload: Record<string, unknown>
  fallback: string
}): React.ReactNode {
  const { t } = useApp()
  const after = isRecord(payload.after) ? payload.after : {}
  const before = isRecord(payload.before) ? payload.before : {}
  const preview = str(after.preview_url) ?? highlightText(card, 'preview')
  const to = str(after.theme_name)
  const from = str(before.theme_name)
  const files = Array.isArray(after.files)
    ? after.files.filter((f): f is string => typeof f === 'string')
    : undefined
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-publish-theme">
      {preview === undefined ? null : (
        <Button
          size="sm"
          variant="outline"
          className="w-fit gap-1.5"
          data-testid="deck-publish-theme-preview"
          title={preview}
          onClick={() => {
            openExternal(preview)
          }}
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t('deck.publish_theme.preview')}
        </Button>
      )}
      {to === undefined ? (
        <Note>{fallback}</Note>
      ) : (
        <ul className="flex flex-col gap-1 text-[13px] leading-5 text-ws-body">
          <li>
            {from === undefined
              ? t('deck.publish_theme.first', { to })
              : t('deck.publish_theme.swap', { from, to })}
          </li>
          {files === undefined ? null : (
            <li className="text-ws-muted-fg" title={files.join('\n')}>
              {files.length === 0
                ? t('deck.publish_theme.files.none')
                : t('deck.publish_theme.files', { n: files.length })}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * WP141（docs/78 §2 红人）：挑人清单卡的主体——按渠道一组一行，列出名字。
 *
 * 原来它走通用的人物排版，卡面上是一个写着「没」的头像配「没写名字」。
 * 这张卡要人回答的是"这批人你认不认"，那就把这批人摆出来。
 */
function CampaignGroups({ groups }: { groups: unknown[] }): React.ReactNode {
  const { t, lang } = useApp()
  const rows = groups.filter(isRecord)
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-campaign-groups">
      {rows.map((g) => {
        const picks = Array.isArray(g.picks) ? g.picks.filter(isRecord) : []
        const names = picks.map((p) => str(p.display_name) ?? str(p.handle)).filter(Boolean)
        const channel = channelLabel(str(g.channel) ?? '', lang)
        return (
          <div
            key={`${channel}:${str(g.role_id) ?? ''}`}
            className="rounded-lg bg-ws-surface p-2.5 text-[13px] leading-5"
            data-testid="deck-campaign-group"
          >
            <b>{t('deck.campaign.group', { channel, n: picks.length })}</b>
            {names.length === 0 ? null : <span className="text-ws-body">：{names.join('、')}</span>}
            {g.allowed === false ? (
              <p className="text-xs text-ws-muted-fg">{t('deck.campaign.blocked')}</p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * before / after 双格（② 改动卡与 ⑪ 策略卡共用的那一块）。
 * WP456-T3（规范 §2.6 第 13 条）：走决定卡的对比块（`.ws-cmp`）——左「现在」、右「改成」（品牌浅底）。
 */
function BeforeAfter({ before, after }: { before: unknown; after: unknown }): React.ReactNode {
  const { t, lang } = useApp()
  const b = pairs(before, lang)
  const a = pairs(after, lang)
  if (b.length === 0 && a.length === 0) return null
  return (
    <div className="ws-cmp mt-0" data-testid="deck-before-after">
      <div className="ws-cmp-cell">
        <div className="ws-cmp-label">{t('deck.before')}</div>
        <div className="ws-num mt-0.5 space-y-0.5 text-[13px] font-medium">
          {b.map(([k, v]) => (
            <div key={`b:${k}:${v}`} className="truncate">
              {k === '' ? v : `${k} ${v}`}
            </div>
          ))}
        </div>
      </div>
      <div className="ws-cmp-cell" data-after="true">
        <div className="ws-cmp-label">{t('deck.after')}</div>
        <div className="ws-num mt-0.5 space-y-0.5 text-[13px] font-medium">
          {a.map(([k, v]) => (
            <div key={`a:${k}:${v}`} className="truncate">
              {k === '' ? v : `${k} ${v}`}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 选项单选列表（⑤ 选择卡的主体）。
 *
 * 36 §2.1：带 `options` 的卡**裸 approve 服务端会拒**，所以只要这张卡有选项，
 * 单选列表就必须在卡面上——哪怕它的主体排版是 ⑪ 策略卡那种配置 diff
 * （`policy_change` 正是这种：又有 before/after，又是问句）。
 */
function OptionList({
  options,
  option,
  onOption,
  kind,
}: {
  options: { id: string; label: string }[]
  option: string
  onOption: (id: string) => void
  /** WP219：按卡种换那一句提示（`card.options.hint.<kind>`，没有就用通用那句）。 */
  kind?: string
}): React.ReactNode {
  const { t } = useApp()
  const name = useId()
  /*
   * WP456-T3（§3.1）：选项组整行可点、选中那行品牌浅底（`.ws-opts`）。通用那句「选一个，答案会沉淀成策略」
   * 不再写在卡上（标题下面那一句已经说了「定了以后照这个办」），只给读屏；按卡种有专门那一句的照旧写出来。
   */
  const special = kind === undefined ? undefined : tOr(t, `card.options.hint.${kind}`, '')
  const hint = special === undefined || special === '' ? t('card.options.hint') : special
  return (
    <div className="flex flex-col gap-1.5">
      {special === undefined || special === '' ? null : (
        <p className="text-xs text-ws-muted-fg">{special}</p>
      )}
      <fieldset
        aria-label={hint}
        className="ws-opts mx-0 mt-0 mb-0 border-0 p-0"
        data-testid="deck-card-options"
      >
        {options.map((o) => {
          const on = o.id === option
          return (
            <label key={o.id} className="ws-opt" data-on={on ? 'true' : 'false'} data-option={o.id}>
              <input
                type="radio"
                className="sr-only"
                name={`deck-opt-${name}`}
                value={o.id}
                checked={on}
                onChange={() => {
                  onOption(o.id)
                }}
              />
              <span aria-hidden className="ws-opt-radio" />
              <span className="min-w-0 flex-1">{o.label}</span>
            </label>
          )
        })}
      </fieldset>
    </div>
  )
}

/** ① 出站文案：正文整段给人看（这一格是 37 §1 第 4 行的"一次一种语言"）。 */
function OutboundBody({ card, mode }: { card: DeckCard; mode: DeckContentMode }): React.ReactNode {
  const { t } = useApp()
  const content = pickContent(card.content_variants, mode)
  return (
    <>
      <p
        data-testid="deck-content"
        data-mode={content.mode}
        className="mt-2.5 rounded-lg bg-ws-surface p-3 text-sm leading-6 whitespace-pre-wrap"
      >
        {content.text}
      </p>
      {content.fell_back ? (
        <p data-testid="deck-content-fallback" className="mt-1.5 text-xs text-ws-warn">
          {t('deck.content.fallback')}
        </p>
      ) : null}
    </>
  )
}

export function DeckCardBody({
  card,
  mode,
  option,
  onOption,
  onOpen,
}: {
  card: DeckCard
  mode: DeckContentMode
  /** 选择题卡当前选中的选项 id */
  option: string
  onOption: (id: string) => void
  onOpen: () => void
}): React.ReactNode {
  const { t, lang } = useApp()
  const usage = useMode()
  const payload = isRecord(card.detail.payload) ? card.detail.payload : {}
  const content = pickContent(card.content_variants, mode)
  const options = card.options ?? []
  /**
   * WP275（界面少字）：正文那一句与标题下那一行（`routed_note`）一模一样时，同一张卡上只说一遍
   * ——正文框不出（① ② 超限卡：「超金额、毛利上限」只在标题下）。
   */
  const reasonText =
    card.routed_note !== undefined && content.text.trim() === card.routed_note.trim()
      ? ''
      : content.text

  const main = ((): React.ReactNode => {
    switch (card.layout) {
      // ⑤ 选择：单选列表，不猜。选项来自服务端，前端不编第三个。
      case 'choice':
        return (
          <div className="mt-2.5" data-testid="deck-layout-choice">
            {/* WP237：「走哪条职责」的选项就是下面那排按钮，这里只放那一句为什么 */}
            {options.length === 0 || card.kind === 'claim' ? (
              <OutboundBody card={card} mode={mode} />
            ) : card.kind === 'theme_choice' && isThemeChoicePayload(card.detail.payload) ? (
              // WP304：选主题卡——高级主题排第一（卖点 + 价格 + 预览），下面是店里的免费主题
              <ThemeChoiceBody
                payload={card.detail.payload}
                options={options}
                option={option}
                onOption={onOption}
              />
            ) : (
              <OptionList options={options} option={option} onOption={onOption} kind={card.kind} />
            )}
          </div>
        )

      // ② 改动：before / after 双格是主体，一句依据放下面
      case 'change':
        // WP316：上传表 / 开始投放 / 撤销卡——一句话 + 表格预览 + 可下载的原表
        if (isAdsSheetPayload(payload)) return <AdsSheetBody payload={payload} />
        // WP420：改预算 / 暂停卡——一行「日预算 $300 → $330」，不露字段名，总闸只留卡头小标签
        if (isAdsChangePayload(payload))
          return <AdsChangeBody payload={payload} reason={reasonText} title={card.title} />
        // WP249：自家版版务卡——原文、举报原因、AI 建议 + 理由、将执行的动作
        if (isOwnSubPayload(payload)) return <OwnSubCardBody payload={payload} />
        // WP254：别的社群的版务卡——将执行什么、原话、依据（批了才经渠道适配器去做）
        if (isModerationPayload(payload)) return <ModerationCardBody payload={payload} />
        // WP322：FAQ 导入 ③ 交负责人的整批卡——几条 + 一两行预览（不出改之前 / 改之后双格）
        if (isFaqBatchPayload(payload)) return <FaqBatchBody payload={payload} />
        // WP350：助理扇出的「要记的 N 条」——按岗位列正文与原文出处
        if (isAssistantNotesPayload(payload)) return <AssistantNotesBody payload={payload} />
        // WP506（1796 C）：AI 提议停用 / 启用几条知识——哪几条、AI 的理由；批了之后能撤销
        if (isKnowledgeToggleBody(payload))
          return <KnowledgeToggleBody card={card} payload={payload} />
        // WP488：「学到 N 条」——每条可改范围、可去掉，一次采纳；「这几条可能过期」——都没变 / 按网站重学
        if (isKnowledgeLearnedBody(payload))
          return <KnowledgeLearnedBody card={card} payload={payload} />
        if (isKnowledgeStaleBody(payload))
          return <KnowledgeStaleBody card={card} payload={payload} />
        // WP335：AI 回答监测的设定卡 / 竞品卡——几行要点 + 就地「改」（改好了带着改过的策略批）
        if (isGeoWatchPayload(payload)) return <GeoWatchCardBody card={card} payload={payload} />
        // WP387：在你的 Google 账号里建 / 改 N 条提醒——每条可勾掉、一次确认（主按钮在卡身里）
        if (isGoogleAlertChangePayload(payload))
          return <GoogleAlertChangeBody card={card} payload={payload} />
        // WP416：红人验收结论——一句话，不露字段名
        if (isKolReviewPayload(payload)) return <KolReviewBody payload={payload} />
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-change">
            <BeforeAfter before={payload.before} after={payload.after} />
            <Note testId="deck-reason">{reasonText}</Note>
          </div>
        )

      // ⑪ 策略：配置 diff。与 ② 同一块双格，但下面那句是"谁能批"而不是"依据"
      case 'policy':
        // WP277（决策 239）：开公司模式时同事那张——一句以后会怎样 + 退之前导出一份（没有双格）
        if (payload.form === 'company_notice')
          return (
            <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-layout-company-notice">
              <Note testId="deck-reason">{reasonText}</Note>
              {options.some((o) => o.id === 'leave') ? <CompanyNoticeExtras /> : null}
            </div>
          )
        // WP324（决策 690）：连接卡 / 配置卡——就地连 / 就地填（主按钮在卡身里），补完原任务自动接着做
        if (payload.form === 'connect_request' || payload.form === 'setup_request')
          return <SetupDeckBody card={card} />
        // WP390：工坊服务卡（价目单 / 需求单 / 下单 / 验收 / 联系方式）——主按钮在卡身里
        if (isServiceCard(card)) return <ServiceCardBody card={card} />
        // WP406（私有 docs/107 §5.1）：岗位更新——逐项「改了什么 / 你改过没」+ 卡身里「全部应用 / 挑着看 / 这次跳过」
        if (isContentDigestPayload(payload)) return <DigestCardBody card={card} payload={payload} />
        // WP304（决策 445）：买高级主题（「花钱」家族）——一个大数（积分）+ 一句这家店一次买断；不出双格、不出「以后都这样」
        if (payload.form === 'theme_purchase')
          return (
            <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-layout-theme-purchase">
              <p className="text-[22px] font-semibold text-ws-ink">
                {t('themes.purchase.credits', { credits: Number(payload.price_credits ?? 0) })}
              </p>
              <Note testId="deck-reason">{reasonText}</Note>
            </div>
          )
        // WP489（决策 1709）：对不上红人的往来 / 没找到往来的红人——卡里就地选、补邮箱（「记下」在卡身里）
        if (isKolMailMatchPayload(payload))
          return <KolMailMatchBody card={card} payload={payload} />
        // WP509：「把红人同步到这张飞书表」——列对应、按哪列认人、同步什么、多久一次、对不上的阶段（「开始同步」在卡身里）
        if (isKolSyncPayload(payload)) return <KolSyncBody card={card} payload={payload} />
        // WP322：「这份表按问答导入」——列对照、一两行预览、几条（按钮就是选项）
        if (isFaqImportPayload(payload)) return <FaqImportBody payload={payload} />
        // WP284（决策 275）：「以后都这样」——标题就是那一句；太长被截了才把整句放进正文，
        // 下面一句说之后怎样、去哪儿改（不出改之前 / 改之后双格，不出「谁能批」那一行）
        // WP441：「要建这条规则吗」——一行白话、试跑、会改掉去向的几封；「建」在卡身里（带上「也处理过去 30 天的」）
        if (isMessageRuleCardPayload(payload))
          return <MessageRuleCardBody card={card} payload={payload} />
        // WP323：记录去处的「定规矩」——一行预览（列 → 这一条会写成什么）+ 一句之后怎样；不出双格
        if (payload.form === 'record_sink') {
          const rows = (Array.isArray(payload.preview) ? payload.preview : [])
            .filter(
              (r): r is [string, string] =>
                Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string',
            )
            .map(([k, v]): [string, string] => [k, v === '' ? '—' : v])
          return (
            <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-layout-record-sink">
              <KeyValues rows={rows} testId="deck-record-sink-preview" />
              <p className="text-xs text-ws-muted-fg" data-testid="deck-reason">
                {reasonText}
              </p>
            </div>
          )
        }
        if (payload.form === 'instruction_rule') {
          const rule = str((payload.after as { rule?: unknown } | undefined)?.rule)
          return (
            <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-layout-rule">
              {rule === undefined || card.title.includes(rule) ? null : (
                <Note testId="deck-rule-text">{rule}</Note>
              )}
              <p className="text-xs text-ws-muted-fg" data-testid="deck-reason">
                {reasonText}
              </p>
            </div>
          )
        }
        /*
         * WP456-T3（§3.1「决定卡说了四层话」）：标题下面只留一句灰字（为什么问你），接着是对比块；
         * 原来那个说明框、「点通过以后都这样做」、选项组的标题都去掉。
         */
        return (
          <div className="mt-1 flex flex-col gap-3" data-testid="deck-layout-policy">
            {/* WP276（界面少字）：通知卡那句「谁改的、已生效、可撤回」下面那一行已经说了，这一句不再说 */}
            {payload.form === 'peer_change_notice' || reasonText === '' ? null : (
              <p className="ws-dcard-desc mt-0" data-testid="deck-reason">
                {reasonText}
              </p>
            )}
            <BeforeAfter before={payload.before} after={payload.after} />
            {/*
              WP275：② 里同事自己改了共用的规矩，这张是「已生效、可撤回」的通知。
              WP456-T3：「点通过以后都这样做」去掉（标题下那句说了）；公司模式下「只有 owner 能批」是新信息，照旧写。
            */}
            {payload.form === 'peer_change_notice' ? (
              <p className="text-xs text-ws-muted-fg">{t('deck.policy.peer_notice')}</p>
            ) : usage.known && usage.mode === 'company' ? (
              <p className="text-xs text-ws-muted-fg">{t('deck.policy.owner_only')}</p>
            ) : null}
          </div>
        )

      // ③ 发布：左预览右说明；排期时间与受众数**必现**（15 §2 / 56 §2）
      case 'publish': {
        // WP418（审计 U9）：发布主题卡不是发帖——只要「打开预览」+ 改了哪几处，不要排期 / 受众 / 空缩略图
        if (card.change_kind === 'publish_theme')
          return <PublishThemeBody card={card} payload={payload} fallback={content.text} />
        const preview = str(payload.preview_image) ?? str(payload.image_url)
        const scheduled = highlightText(card, 'scheduled')
        const audience = highlightText(card, 'audience')
        // WP332：公关在别人帖子下回一条评论——被回的那一条点得开（插件也按它找回复框）
        const parentUrl = isRecord(payload.after) ? str(payload.after.parent_url) : undefined
        // WP421（自查 general）：批了也不会自动发（新闻稿分发、外部论坛还没接）——卡上照实写「要你自己发」
        const manual = isRecord(payload.after) && payload.after.manual_send === true
        return (
          <div className="mt-2.5 flex gap-3" data-testid="deck-layout-publish">
            {/* WP418（审计 U10）/ WP421（界面清单 #1）：没有封面就不画占位块 */}
            {preview === undefined ? null : (
              <div
                data-testid="deck-publish-preview"
                className="size-24 flex-none overflow-hidden rounded-xl bg-ws-tint"
              >
                <img src={preview} alt="" className="size-full object-cover" />
              </div>
            )}
            <div className="min-w-0 flex-1 text-[13px] leading-5 text-ws-body">
              <p className="whitespace-pre-wrap">{content.text}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span
                  className={`inline-flex h-[22px] items-center rounded-md px-2 text-xs ${
                    manual ? 'bg-ws-warn-bg text-ws-warn' : 'bg-ws-surface'
                  }`}
                  data-testid={manual ? 'deck-publish-manual' : undefined}
                >
                  {manual
                    ? t('deck.publish.manual')
                    : t('deck.publish.when', { when: scheduled ?? t('deck.publish.now') })}
                </span>
                {/* WP418（审计 U10）：没有受众数就不出「受众 · —」 */}
                {audience === undefined ? null : (
                  <span className="inline-flex h-[22px] items-center rounded-md bg-ws-surface px-2 text-xs">
                    {t('deck.publish.audience', { n: audience })}
                  </span>
                )}
              </div>
              {parentUrl === undefined ? null : (
                <a
                  href={parentUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={parentUrl}
                  className="mt-1.5 inline-flex items-center gap-1 text-xs text-ws-muted-fg hover:text-ws-fg"
                  data-testid="deck-parent-link"
                >
                  {t('redditw.parent')}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
              <DesignNoteLine card={card} />
            </div>
          </div>
        )
      }

      // ④ 金钱：金额一个大字，旁边是额度与依据的键值对
      case 'money': {
        const amount = highlightText(card, 'amount') ?? valueText(payload.amount)
        const rows = pairs(payload.caps, lang).concat(pairs(payload.basis, lang))
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-money">
            <div className="flex items-end gap-3.5">
              <span className="ws-display text-[28px] leading-none" data-testid="deck-money-amount">
                {amount}
              </span>
              <div className="flex-1">
                <KeyValues rows={rows} testId="deck-money-kv" />
              </div>
            </div>
            <Note testId="deck-reason">{reasonText}</Note>
          </div>
        )
      }

      // ⑥ 变体：N 张缩略图，人点一张（定稿入库另出一张 L1 卡）
      case 'variants': {
        const variants = Array.isArray(payload.variants) ? payload.variants : []
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-variants">
            <div className="grid grid-cols-3 gap-2" data-testid="deck-variant-grid">
              {variants.map((v, i) => {
                const rec = isRecord(v) ? v : {}
                const id = str(rec.id) ?? String(i)
                const url = str(rec.url) ?? str(rec.preview_image)
                const selected = option === id
                return (
                  <button
                    key={id}
                    type="button"
                    data-testid="deck-variant"
                    data-selected={selected ? 'true' : undefined}
                    aria-pressed={selected}
                    onClick={() => {
                      onOption(id)
                    }}
                    className={`aspect-[4/3] overflow-hidden rounded-lg bg-ws-tint ${
                      selected ? 'ring-2 ring-ws-brand' : ''
                    }`}
                  >
                    {url === undefined ? null : (
                      <img
                        src={url}
                        alt={str(rec.label) ?? id}
                        className="size-full object-cover"
                      />
                    )}
                  </button>
                )
              })}
            </div>
            {variants.length === 0 ? <Note>{content.text}</Note> : null}
            <DesignNoteLine card={card} />
          </div>
        )
      }

      // ⑦ 事后决定：系统已经做了一件事，判据键值对是主体，问的是"要不要改回来"
      case 'aftermath': {
        // WP224：本周经营一页纸是一张五段的卡（数带出处 tooltip），不是一排键值
        if (isWeeklyReview(payload)) return <WeeklyReviewBody payload={payload} />
        // WP331：AI 发布的报告同一类（报表）：周期 + 正文 + 复制 / 导出
        if (isReport(payload)) return <ReportBody payload={payload} />
        const rows = pairs(payload.facts, lang).concat(pairs(payload.after, lang))
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-aftermath">
            <div className="rounded-lg bg-ws-surface p-3">
              {rows.length === 0 ? (
                <p className="text-[13px] text-ws-body">{content.text}</p>
              ) : (
                <KeyValues rows={rows} testId="deck-aftermath-kv" />
              )}
            </div>
            {rows.length === 0 ? null : <Note testId="deck-reason">{reasonText}</Note>}
          </div>
        )
      }

      // ⑧ 人物：头像 + 资料摘要 + 规则匹配结果
      case 'person': {
        // WP141：红人挑人清单卡不是「一个人」，是按渠道分组的一批人——照组列名字
        if (Array.isArray(payload.by_channel)) return <CampaignGroups groups={payload.by_channel} />
        const who = isRecord(payload.person) ? payload.person : {}
        const named = str(who.name) ?? str(payload.name)
        const name = named ?? t('deck.person.unknown')
        const profile = str(who.profile) ?? str(payload.profile)
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-person">
            <div className="flex items-center gap-3">
              <span
                data-testid="deck-person-avatar"
                className="inline-flex size-10 flex-none items-center justify-center rounded-full bg-ws-info-bg text-sm font-semibold text-ws-info"
              >
                {named === undefined ? '?' : named.slice(0, 1)}
              </span>
              <div className="min-w-0 flex-1 text-[13px] leading-5">
                <b>{name}</b>
                {profile === undefined ? null : <div className="text-ws-muted-fg">{profile}</div>}
              </div>
            </div>
            <Note testId="deck-reason">{reasonText}</Note>
          </div>
        )
      }

      // ⑨ 转交 / 认领：主体是**原话** + 分类依据
      case 'handoff': {
        // WP276（docs/95 §4.3 第 3 步）：「X 想把「…」交给你」——留言、到哪了、截止、几号退回
        if (payload.form === 'handoff') {
          const note = str(payload.note)
          const where = str(payload.matter_summary)
          const day = (iso: string | undefined): string | undefined => iso?.slice(5, 10)
          const facts = [
            // WP278：「把发起人交给你 / 请你一起做」——接下以后会怎样，一句
            str(payload.what),
            where === undefined || where === note
              ? undefined
              : `${t('handoff.card.where')}：${where}`,
            str(payload.progress),
            str(payload.due) === undefined
              ? undefined
              : t('handoff.card.due', { date: day(str(payload.due)) ?? '' }),
            str(payload.expires_at) === undefined
              ? undefined
              : t('handoff.card.back', { date: day(str(payload.expires_at)) ?? '' }),
          ].filter((x): x is string => x !== undefined)
          return (
            <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-layout-handoff-offer">
              {note === undefined ? null : (
                <blockquote
                  data-testid="deck-quote"
                  className="rounded-lg bg-ws-surface p-3 text-[13px] leading-5 whitespace-pre-wrap text-ws-body"
                >
                  {note}
                </blockquote>
              )}
              {facts.length === 0 ? null : (
                <ul className="flex flex-col gap-0.5 text-xs text-ws-muted-fg">
                  {facts.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
            </div>
          )
        }
        const quote = str(payload.quote) ?? str(payload.original) ?? content.text
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-handoff">
            <blockquote
              data-testid="deck-quote"
              className="rounded-lg bg-ws-surface p-3 text-[13px] leading-5 whitespace-pre-wrap text-ws-body"
            >
              {quote}
            </blockquote>
            {/* WP182：没有单独的依据时不再把正文原样重复一遍（离职交接卡的正文就是那份清单） */}
            {str(payload.reason) === undefined && quote === content.text ? null : (
              <p className="text-xs text-ws-muted-fg">
                {t('deck.handoff.basis', { basis: str(payload.reason) ?? content.text })}
              </p>
            )}
          </div>
        )
      }

      /*
       * ⑩ 接管：只说发生了什么、人要做什么。
       *
       * **Agent 不重试**，也不替人输密码——那个按钮把受控浏览器打开，剩下的是人的事。
       */
      case 'takeover': {
        const url = str(payload.url) ?? str(payload.target_url)
        return (
          <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-takeover">
            <Note testId="deck-reason">{reasonText}</Note>
            <button
              type="button"
              data-testid="deck-takeover-open"
              onClick={onOpen}
              className="inline-flex h-8 w-fit items-center rounded-md bg-ws-brand px-3 text-xs font-medium text-ws-brand-fg"
            >
              {t('deck.takeover.open')}
            </button>
            {url === undefined ? null : <p className="truncate text-xs text-ws-muted-fg">{url}</p>}
          </div>
        )
      }

      // ① 出站文案（也是兜底）
      default:
        // WP329：Reddit「发出去」卡——卡上能改字，「发送」在卡身里（批了交给插件填进页面、你自己点发送）
        if (isRedditWritePayload(payload)) return <RedditWriteBody card={card} payload={payload} />
        // WP442：催促卡——「X 还没回」：你哪天发的、催促草稿（就地修改）、「发出」在卡身里
        if (isFollowUpNudgePayload(payload))
          return <FollowUpCardBody card={card} payload={payload} />
        // WP504（决策 1777 A）：批量开发信——名单、发件 / 信 / 节奏 / 跳过、样信（F3）
        if (isKolOutreachBatchPayload(payload))
          return <KolOutreachBatchBody payload={payload} card={card} />
        // WP416：红人开发信——卡面直接放正文（前 6 行可展开）与要先看一眼的几句
        if (isKolOutreachPayload(payload)) return <KolOutreachBody payload={payload} />
        return (
          <div data-testid="deck-layout-outbound">
            <OutboundBody card={card} mode={mode} />
          </div>
        )
    }
  })()

  /*
   * 有选项就一定要有单选列表（36 §2.1 裸 approve 会被拒）。
   * ⑤ 自己就是列表，⑥ 的缩略图格本身就是选法——只有这两种不再追加一份。
   */
  // WP276：交给你的卡，选项就是动作行上那几个「接下」按钮——不再追加一份单选列表
  // WP276：② 的「知道了 / 撤回」通知也一样——两个选项就是动作行上的两个按钮
  const handoffOffer =
    (card.detail.payload as { form?: unknown } | undefined)?.form === 'handoff' ||
    (card.detail.payload as { form?: unknown } | undefined)?.form === 'peer_change_notice' ||
    // WP277：开公司模式时同事那张「知道了 / 我要退出」
    (card.detail.payload as { form?: unknown } | undefined)?.form === 'company_notice' ||
    // WP284：「以后都这样」那张「记进规矩 / 不用」
    (card.detail.payload as { form?: unknown } | undefined)?.form === 'instruction_rule' ||
    // WP322：FAQ 导入那张「记下 / 只加新的 / 不用」
    (card.detail.payload as { form?: unknown } | undefined)?.form === 'faq_import' ||
    // WP323：记录去处那张「记下 / 不用」
    (card.detail.payload as { form?: unknown } | undefined)?.form === 'record_sink' ||
    // WP441：「要建这条规则吗」（建 / 不要都在卡身里）
    (card.detail.payload as { form?: unknown } | undefined)?.form === 'message_rule' ||
    // WP509：同步设置卡（「开始同步」在卡身里，「不用」= 卡底的驳回）
    (card.detail.payload as { form?: unknown } | undefined)?.form === 'kol_sync'
  const needsOptions =
    options.length > 0 && card.layout !== 'choice' && card.layout !== 'variants' && !handoffOffer
  return (
    <>
      {main}
      {needsOptions ? (
        <div className="mt-3">
          <OptionList options={options} option={option} onOption={onOption} kind={card.kind} />
        </div>
      ) : null}
    </>
  )
}
