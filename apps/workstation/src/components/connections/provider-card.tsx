/**
 * 可连接的一张卡：一句话说明 → "要准备什么"（≤ 5 步 + 外链）→ 向导。
 *
 * 两种向导：
 * - **OAuth 类**：点"去授权"打开平台自己的授权页（Electron 里经桥接 `openExternal`，
 *   浏览器里新窗口），然后轮询直到连上。密码只输在对方网站上，我们连表单都不出。
 * - **表单类**：展开一个**原生 `<form>`**（`SecureForm`），提交只打一条 `/submit`，
 *   提交完立刻试连并把结果显示出来。
 */

import { ChevronDown, ChevronRight, ExternalLink, Plug } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint, SafetyNote } from '@/components/ui/hint'
import type {
  ConnectTestResult,
  ProviderAuthOption,
  ProviderFieldSpec,
  ProviderView,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { SecureForm } from './secure-form'
import { TestResultLine } from './test-result'

export type WizardPhase = 'idle' | 'form' | 'authorizing' | 'saving'

export function ProviderCard({
  provider,
  highlighted,
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
  phase: WizardPhase
  /** `begin` 回来的字段描述；没走过 begin 就用目录里那份。 */
  fields: ProviderFieldSpec[] | undefined
  result: ConnectTestResult | undefined
  oauthUrl: string | undefined
  /** 邮箱识别请求要带的岗位（连接是所有者的事）。 */
  assignment: string | undefined
  onStart: (auth_option?: string) => void
  onCancel: () => void
  onSubmit: (values: Record<string, string>) => void
}): React.ReactNode {
  const { t } = useApp()
  const [guideOpen, setGuideOpen] = useState(false)
  const oauth = provider.auth === 'oauth2'
  const busy = phase === 'saving'

  // WP25：一个服务两种接法时先让用户选一次（Shopify）。默认选推荐的那条。
  const options = provider.auth_options ?? []
  const [optionId, setOptionId] = useState<string | undefined>(
    options.find((o) => o.recommended)?.id ?? options[0]?.id,
  )
  const option: ProviderAuthOption | undefined =
    options.find((o) => o.id === optionId) ?? options[0]
  // 选了哪条，"要准备什么"与表单字段就跟着换
  const guide = option?.setup_guide ?? provider.setup_guide

  return (
    <Card
      data-testid="provider-card"
      data-service={provider.service}
      data-highlighted={highlighted ? 'true' : 'false'}
      className={cn(highlighted && 'ring-2 ring-primary')}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Plug className="size-4" aria-hidden />
          {provider.label}
          {provider.data_note === undefined ? null : (
            <Hint text={provider.data_note} testId="provider-note" />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {/*
          WP43 ③：卡面只留一句话说明。原来跟在后面那段「连上之后会怎样」
          （`data_note`）压成标题旁一个问号，「要准备什么」照旧是下面的折叠区。
        */}
        <p className="text-muted-foreground">{guide.summary}</p>

        {options.length > 1 ? (
          <fieldset className="flex flex-col gap-1.5" data-testid="auth-options">
            <legend className="sr-only">{t('connections.auth_option')}</legend>
            {options.map((o) => (
              <label
                key={o.id}
                data-testid="auth-option"
                data-option={o.id}
                data-selected={option?.id === o.id ? 'true' : 'false'}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs',
                  option?.id === o.id ? 'border-primary bg-primary/5' : 'border-border',
                )}
              >
                <input
                  type="radio"
                  className="mt-0.5"
                  name={`auth-option-${provider.service}`}
                  value={o.id}
                  checked={option?.id === o.id}
                  disabled={phase !== 'idle'}
                  onChange={() => {
                    setOptionId(o.id)
                  }}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {o.label}
                    {o.recommended ? (
                      <span className="ml-1.5 rounded bg-primary/10 px-1 py-px text-[10px] text-primary">
                        {t('connections.recommended')}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground">{o.summary}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}

        <div>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={guideOpen}
            onClick={() => {
              setGuideOpen((v) => !v)
            }}
          >
            {guideOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            {t('connections.setup')}
          </Button>
          {guideOpen ? (
            <div className="mt-1 flex flex-col gap-2 rounded-md border bg-muted/30 p-2.5">
              <ol
                className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground"
                data-testid="setup-steps"
              >
                {guide.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <div className="flex flex-wrap gap-3">
                {guide.links.map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                  >
                    {link.label}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {provider.available ? null : (
          <p className="text-xs text-destructive" data-testid="provider-unavailable">
            {t('connections.unavailable')}
            {provider.unavailable_reason === undefined ? '' : `：${provider.unavailable_reason}`}
          </p>
        )}

        {phase === 'form' ? (
          <SecureForm
            service={provider.service}
            fields={fields ?? option?.fields ?? provider.fields}
            busy={busy}
            {...(assignment === undefined ? {} : { assignment })}
            onCancel={onCancel}
            onSubmit={onSubmit}
          />
        ) : phase === 'authorizing' ? (
          <div className="flex flex-col gap-1.5" data-testid="oauth-waiting">
            <p className="text-xs text-muted-foreground">{t('connections.oauth.opened')}</p>
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
                onStart(option?.id)
              }}
            >
              {oauth ? t('connections.authorize') : t('connections.connect')}
            </Button>
            {/* 例外：密码输在哪儿是安全承诺，不藏 */}
            {oauth ? <SafetyNote text={t('connections.oauth.hint')} /> : null}
          </div>
        )}

        {result === undefined ? null : <TestResultLine result={result} />}
      </CardContent>
    </Card>
  )
}
