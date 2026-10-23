/**
 * 可连接的一项。WP456-T6（WP456 §3.8，示意稿 6）起**不是一张卡、是列表组里的一行**：
 * 图标 + 名字 + 一行很短的说明（`connections.sub.<service>`，「IMAP / SMTP」「访客、来源、转化」这种）
 * + 右边一个问号（悬停是介绍，点开是教程）+「连接」次按钮。表单、等授权、试连结果、数据来源
 * 都在这一行下面就地展开。「看教程」那个绿字链接没有了——教程就在问号里。
 *
 * 以下是这一项从卡片时代留下来的规矩，照旧：
 *
 * 原来：可连接的一张卡：图标 + 名字 + 问号 + 按钮 +「看教程」（WP210 按 Luoye 09-30 再减一轮）。
 *
 * WP210：卡面上那一句介绍（`connections.line.<service>`）也收进名字旁的问号——每张卡都重复
 * 一句话，一页二十多张就是二十多句；「点下面的按钮会打开对方网站…我们看不到」这类安全说明
 * 统一放到「可以连接」标题旁的问号里说一次（连接页），卡上一句不留。数据来源设置
 * （用我的 / 用 Agents 工坊的、数据从哪里来）默认收起，点「数据来源」才展开。
 *
 * WP157（36 §7）：卡上不再铺「要准备什么」的步骤与外链，也不铺服务端那段成段介绍——
 * 它们在每类连接一篇的教程里（`docs/help/conn-*.md`，`HELP_BY_SERVICE`）；成段介绍与
 * 「连上之后会怎样」合成标题旁一个问号。没有教程的卡（将来新加的），步骤与外链在
 * 「看教程」的对话框里现拼，一条不丢。
 *
 * 两种向导：
 * - **OAuth 类**：点"去授权"打开平台自己的授权页（Electron 里经桥接 `openExternal`，
 *   浏览器里新窗口），然后轮询直到连上。密码只输在对方网站上，我们连表单都不出。
 * - **表单类**：展开一个**原生 `<form>`**（`SecureForm`），提交只打一条 `/submit`，
 *   提交完立刻试连并把结果显示出来。
 *
 * WP265：有一键授权的卡（Shopify）把那一块作为主按钮（`oneClick`），老的接法收进卡内
 * 「高级」折叠——普通用户默认看不到；老接法正在进行中（表单开着 / 等授权）时自动展开。
 */

import { ChevronDown, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { BrandIcon } from '@/components/brand-icons'
import { TutorialHint } from '@/components/help/tutorial-link'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import type { ConnectTestResult, ProviderFieldSpec, ProviderView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { firstSentence, HELP_BY_SERVICE, shortReason, templateGuide } from '@/lib/help'
import { cn } from '@/lib/utils'
import { CapabilitySourceSwitch, capabilityOf } from './capability-source-switch'
import {
  ByoSourceCard,
  DataSourceRouteControl,
  REDDIT_READ_LEVELS,
  REDDIT_READ_ROUTE_KEY,
} from './data-source-route'
import { SecureForm } from './secure-form'
import { TestResultLine } from './test-result'

export type WizardPhase = 'idle' | 'form' | 'authorizing' | 'saving'

/** WP456-T6：一项的那一行很短的说明（没有词条的就不写，名字自己站着）。 */
export function providerSub(service: string, t: (key: string) => string): string | undefined {
  const key = `connections.sub.${service}`
  const sub = t(key)
  return sub === key ? undefined : sub
}

export function ProviderCard({
  provider,
  highlighted,
  connected,
  phase,
  fields,
  result,
  oauthUrl,
  assignment,
  onStart,
  onCancel,
  onSubmit,
  oneClick,
  advancedLabel,
  advancedNote,
}: {
  provider: ProviderView
  /** 从「去连接」跳过来时高亮这一行。 */
  highlighted: boolean
  /** 这一项用户自己连上没有（49 M2 的开关据此决定要不要多说一句）。 */
  connected: boolean
  phase: WizardPhase
  /** `begin` 回来的字段描述；没走过 begin 就用目录里那份。 */
  fields: ProviderFieldSpec[] | undefined
  result: ConnectTestResult | undefined
  oauthUrl: string | undefined
  /** 邮箱识别请求要带的岗位（连接是所有者的事）。 */
  assignment: string | undefined
  /** WP44 起没有第二条接法可选，参数保留只为不动调用方（连接页仍带着它的 wizard 状态）。 */
  onStart: (auth_option?: string) => void
  onCancel: () => void
  onSubmit: (values: Record<string, string>) => void
  /** WP265：一键授权那一块（有它就是主按钮，老接法进「高级」折叠）。 */
  oneClick?: React.ReactNode
  /** 「高级」折叠按钮上的字（缺省「高级」）。 */
  advancedLabel?: string
  /** WP418（审计 U17）：展开之后第一行的那一句解释（这条接法是什么、什么时候用）。 */
  advancedNote?: string
}): React.ReactNode {
  const { t } = useApp()
  const oauth = provider.auth === 'oauth2'
  const busy = phase === 'saving'

  // WP44：每个 provider 只有一条接法。Shopify 曾经有两条（Dev Dashboard 应用 /
  // 老的 shpat_ 直填令牌），老的那条已经删掉——留着只会让非技术用户在两张表单之间猜。
  const guide = provider.setup_guide
  const tutorial = HELP_BY_SERVICE[provider.service]
  /** 问号里那一句：词条里压好的（中英都有）；认不得的退回服务端介绍的第一句。 */
  const lineKey = `connections.line.${provider.service}`
  const line = t(lineKey) === lineKey ? firstSentence(guide.summary) : t(lineKey)
  // WP210：那一句 + 成段介绍 +「连上之后会怎样」都在名字旁这一个问号里（原话一字不少）
  const about = [line, guide.summary === line ? '' : guide.summary, provider.data_note ?? '']
    .filter((x) => x !== '')
    .join(' ')
  const sub = providerSub(provider.service, t)
  /**
   * 名字后面那段括号（「任意邮箱（IMAP / SMTP）」「Gmail（Google 授权）」）和下面那一行说的是同一件事：
   * 有那一行时名字只写括号前面（示意稿 6：「任意邮箱」+「IMAP / SMTP」）。
   */
  const name =
    sub === undefined
      ? provider.label
      : provider.label.replace(/\s*[（(][^（）()]*[）)]\s*$/u, '').trim() || provider.label
  const capability = capabilityOf(provider.service)
  // WP220（Luoye 10-05）：Reddit 卡上也有「数据从哪里来」——接口中台 → 浏览器只读，可调顺序、可停用
  const redditRoute = provider.service === 'reddit'
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  /** 老接法正在进行中（表单开着 / 等授权 / 刚出了结果）就别把它藏起来。 */
  const advancedShown = advancedOpen || phase !== 'idle' || result !== undefined
  /** 点不动的原因压成一句；原话在旁边的问号里。还没做的那几张直说「还没做」。 */
  const reason =
    provider.unavailable_reason === undefined
      ? undefined
      : provider.planned === true
        ? t('connections.directory.planned')
        : shortReason(provider.unavailable_reason)
  const unavailableLine = (
    <p
      className={cn(
        'flex min-w-0 items-center gap-1 text-xs',
        provider.planned === true ? 'text-ws-muted-fg' : 'text-ws-warn',
      )}
      data-slot="status"
      data-testid="provider-unavailable"
    >
      <span className="truncate">
        {t('connections.unavailable')}
        {reason === undefined ? '' : `：${reason}`}
      </span>
      {provider.unavailable_reason === undefined ||
      provider.unavailable_reason === reason ? null : (
        <Hint text={provider.unavailable_reason} testId="provider-unavailable-why" />
      )}
    </p>
  )
  /** 「连接 / 去授权」这颗次按钮：没有一键授权、没在填表 / 等授权时放在这一行最右边。 */
  const startButton = (
    <Button
      size="sm"
      variant="secondary"
      className="min-w-16"
      disabled={!provider.available || busy}
      data-testid="provider-start"
      onClick={() => {
        onStart()
      }}
    >
      {oauth ? t('connections.authorize') : t('connections.connect')}
    </Button>
  )
  /** 填表 / 等授权 / 试连结果：在这一行下面就地展开。 */
  const wizardBody =
    phase === 'form' ? (
      <SecureForm
        service={provider.service}
        fields={fields ?? provider.fields}
        busy={busy}
        safetyNote={false}
        {...(assignment === undefined ? {} : { assignment })}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    ) : phase === 'authorizing' ? (
      <div className="flex flex-wrap items-center gap-3" data-testid="oauth-waiting">
        <p className="ws-shimmer text-xs text-ws-muted-fg" data-slot="status">
          {t('connections.oauth.opened')}
        </p>
        {oauthUrl === undefined ? null : (
          <a
            href={oauthUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="ws-link inline-flex items-center gap-1 text-xs"
          >
            {t('connections.oauth.manual')}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
        <Button size="xs" variant="ghost" onClick={onCancel}>
          {t('connections.cancel')}
        </Button>
      </div>
    ) : null
  const inline = oneClick === undefined && phase === 'idle'
  const hasSources = capability !== undefined || redditRoute

  return (
    <div
      data-testid="provider-card"
      data-service={provider.service}
      data-highlighted={highlighted ? 'true' : 'false'}
      className={cn(
        'ws-row flex-col items-stretch gap-2 py-2.5',
        highlighted && 'bg-ws-brand-soft/30 ring-2 ring-ws-brand/40 ring-inset',
      )}
    >
      <div className="flex min-h-9 items-center gap-3">
        {/* WP45：这一行戴的是这家自己的标志（品牌色原样），认不出的才落通用插头 */}
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-ws-surface">
          <BrandIcon provider={provider.service} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ws-read font-medium text-ws-ink" data-slot="title">
            {name}
          </p>
          {/* 点不动的那几项：原因占说明那一行（要人知道为什么点不了）；一键授权的在「高级」里说 */}
          {!provider.available && oneClick === undefined ? (
            unavailableLine
          ) : sub === undefined ? null : (
            <p className="truncate text-xs text-ws-muted-fg" data-testid="provider-line">
              {sub}
            </p>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {/*
            WP456-T6（§3.8）：一个问号——悬停是介绍（原来名字旁那颗），点开是教程（原来的「看教程」）。
            没有教程文章的：步骤与外链在对话框里现拼；什么都没有的只是个问号。
          */}
          {tutorial !== undefined || guide.steps.length + guide.links.length > 0 ? (
            <TutorialHint
              text={about}
              {...(tutorial !== undefined
                ? { slug: tutorial }
                : { guide: { title: provider.label, markdown: templateGuide(guide) } })}
            />
          ) : about === '' ? null : (
            <Hint text={about} testId="provider-note" className="size-7" />
          )}
          {inline ? startButton : null}
        </span>
      </div>

      {inline && result === undefined && !sourcesOpen && !hasSources ? null : (
        <div className="flex flex-col gap-2 pl-10">
          {oneClick}
          {oneClick !== undefined ? (
            <button
              type="button"
              className="ws-link-muted inline-flex w-fit items-center gap-1 text-xs"
              aria-expanded={advancedShown}
              data-testid="provider-advanced-toggle"
              onClick={() => {
                setAdvancedOpen((v) => !v)
              }}
            >
              {advancedLabel ?? t('connections.advanced')}
              <ChevronDown
                aria-hidden
                className={cn('size-3.5 transition-transform', advancedShown && 'rotate-180')}
              />
            </button>
          ) : null}
          {oneClick !== undefined && advancedShown ? (
            <div className="flex flex-col gap-2" data-testid="provider-legacy">
              {advancedNote === undefined ? null : (
                <p className="text-xs text-ws-muted-fg" data-testid="provider-advanced-note">
                  {advancedNote}
                </p>
              )}
              {provider.available ? null : unavailableLine}
              {wizardBody ?? <div>{startButton}</div>}
            </div>
          ) : null}
          {oneClick === undefined ? wizardBody : null}
          {result === undefined ? null : <TestResultLine result={result} />}

          {/*
            49 M2 / WP126：数据类的「用我的 / 用 Agents 工坊的」开关，红人那五项再加「数据从哪里来」
            与自带数据接口。WP210：默认收起，点「数据来源」才展开——绝大多数人连上就完了。
            没有第二条路的（你自己店里的、你自己账号里的数据）连这个按钮都不出。
          */}
          {!hasSources ? null : (
            <div className="flex flex-col gap-2" data-testid="provider-sources">
              <button
                type="button"
                className="ws-link-muted inline-flex w-fit items-center gap-1 text-xs"
                aria-expanded={sourcesOpen}
                data-testid="provider-sources-toggle"
                onClick={() => {
                  setSourcesOpen((v) => !v)
                }}
              >
                {t('connections.sources.toggle')}
                <ChevronDown
                  aria-hidden
                  className={cn('size-3.5 transition-transform', sourcesOpen && 'rotate-180')}
                />
              </button>
              {sourcesOpen ? (
                <>
                  <CapabilitySourceSwitch
                    service={provider.service}
                    connected={connected}
                    {...(assignment === undefined ? {} : { assignment })}
                  />
                  {redditRoute ? (
                    <DataSourceRouteControl
                      channel="reddit"
                      assignment={assignment}
                      routeKey={REDDIT_READ_ROUTE_KEY}
                      levels={REDDIT_READ_LEVELS}
                      note="data.route.reddit_note"
                    />
                  ) : null}
                  {capability?.startsWith('kol.') === true ? (
                    <>
                      <DataSourceRouteControl
                        channel={capability.slice(4)}
                        assignment={assignment}
                      />
                      <ByoSourceCard channel={capability.slice(4)} />
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
