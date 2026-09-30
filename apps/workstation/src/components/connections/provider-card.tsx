/**
 * 可连接的一张卡：图标 + 名字 + 问号 + 按钮 +「看教程」（WP210 按 Luoye 09-30 再减一轮）。
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
 */

import { ChevronDown, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { BrandIcon } from '@/components/brand-icons'
import { InlineGuideLink, TutorialLink } from '@/components/help/tutorial-link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import type { ConnectTestResult, ProviderFieldSpec, ProviderView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { firstSentence, HELP_BY_SERVICE, shortReason, templateGuide } from '@/lib/help'
import { cn } from '@/lib/utils'
import { CapabilitySourceSwitch, capabilityOf } from './capability-source-switch'
import { ByoSourceCard, DataSourceRouteControl } from './data-source-route'
import { SecureForm } from './secure-form'
import { TestResultLine } from './test-result'

export type WizardPhase = 'idle' | 'form' | 'authorizing' | 'saving'

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
}: {
  provider: ProviderView
  /** 从「去连接」跳过来时高亮这一张。 */
  highlighted: boolean
  /** 这张卡用户自己连上没有（49 M2 的开关据此决定要不要多说一句）。 */
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
}): React.ReactNode {
  const { t } = useApp()
  const oauth = provider.auth === 'oauth2'
  const busy = phase === 'saving'

  // WP44：每个 provider 只有一条接法。Shopify 曾经有两条（Dev Dashboard 应用 /
  // 老的 shpat_ 直填令牌），老的那条已经删掉——留着只会让非技术用户在两张表单之间猜。
  const guide = provider.setup_guide
  const tutorial = HELP_BY_SERVICE[provider.service]
  /** 卡面上那一句：词条里压好的（中英都有）；认不得的退回服务端介绍的第一句。 */
  const lineKey = `connections.line.${provider.service}`
  const line = t(lineKey) === lineKey ? firstSentence(guide.summary) : t(lineKey)
  // WP210：那一句 + 成段介绍 +「连上之后会怎样」都在名字旁这一个问号里（原话一字不少）
  const about = [line, guide.summary === line ? '' : guide.summary, provider.data_note ?? '']
    .filter((x) => x !== '')
    .join(' ')
  const capability = capabilityOf(provider.service)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  /** 点不动的原因压成一句；原话在旁边的问号里。还没做的那几张直说「还没做」。 */
  const reason =
    provider.unavailable_reason === undefined
      ? undefined
      : provider.planned === true
        ? t('connections.directory.planned')
        : shortReason(provider.unavailable_reason)

  return (
    <Card
      data-testid="provider-card"
      data-service={provider.service}
      data-highlighted={highlighted ? 'true' : 'false'}
      className={cn(highlighted && 'ring-2 ring-primary')}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          {/* WP45：卡上戴的是这家自己的标志（品牌色原样），认不出的才落通用插头 */}
          <BrandIcon provider={provider.service} />
          {provider.label}
          {about === '' ? null : <Hint text={about} testId="provider-note" />}
          {tutorial !== undefined ? (
            <TutorialLink slug={tutorial} className="ml-auto font-normal" />
          ) : guide.steps.length + guide.links.length === 0 ? null : (
            <InlineGuideLink
              title={provider.label}
              markdown={templateGuide(guide)}
              className="ml-auto font-normal"
            />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {provider.available ? null : (
          <p
            className="flex items-center gap-1 text-xs text-destructive"
            data-slot="status"
            data-testid="provider-unavailable"
          >
            {t('connections.unavailable')}
            {reason === undefined ? '' : `：${reason}`}
            {provider.unavailable_reason === undefined ||
            provider.unavailable_reason === reason ? null : (
              <Hint text={provider.unavailable_reason} testId="provider-unavailable-why" />
            )}
          </p>
        )}

        {phase === 'form' ? (
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
          <div className="flex flex-col gap-1.5" data-testid="oauth-waiting">
            <p className="text-xs text-muted-foreground" data-slot="status">
              {t('connections.oauth.opened')}
            </p>
            {oauthUrl === undefined ? null : (
              <a
                href={oauthUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
              >
                {t('connections.oauth.manual')}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
            <div>
              <Button size="xs" variant="ghost" onClick={onCancel}>
                {t('connections.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!provider.available || busy}
              onClick={() => {
                onStart()
              }}
            >
              {oauth ? t('connections.authorize') : t('connections.connect')}
            </Button>
          </div>
        )}

        {result === undefined ? null : <TestResultLine result={result} />}

        {/*
          49 M2 / WP126：数据类卡的「用我的 / 用 Agents 工坊的」开关，红人那五张再加「数据从哪里来」
          与自带数据接口。WP210：默认收起，点「数据来源」才展开——绝大多数人连上就完了。
          没有第二条路的卡（你自己店里的、你自己账号里的数据）连这个按钮都不出。
        */}
        {capability === undefined ? null : (
          <div className="flex flex-col gap-2" data-testid="provider-sources">
            <Button
              size="xs"
              variant="ghost"
              className="self-start px-1 text-muted-foreground"
              aria-expanded={sourcesOpen}
              data-testid="provider-sources-toggle"
              onClick={() => {
                setSourcesOpen((v) => !v)
              }}
            >
              {t('connections.sources.toggle')}
              <ChevronDown
                aria-hidden
                className={cn('transition-transform', sourcesOpen && 'rotate-180')}
              />
            </Button>
            {sourcesOpen ? (
              <>
                <CapabilitySourceSwitch
                  service={provider.service}
                  connected={connected}
                  {...(assignment === undefined ? {} : { assignment })}
                />
                {capability.startsWith('kol.') ? (
                  <>
                    <DataSourceRouteControl channel={capability.slice(4)} assignment={assignment} />
                    <ByoSourceCard channel={capability.slice(4)} />
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
