/**
 * 那份 `DESIGN.md` 的**可视化**那一半（71 §4，WP122）。
 *
 * 一条贯穿全篇的规矩：**每一格都点得开出处**。一个色块不是一个色块，它是
 * "站上 `--color-brand` 这条变量"或者"手册第 3 页那一行"。规范本身是从别人的
 * 站上量出来的，量错在所难免——所以用户必须随时能问"你凭什么说这是主色"。
 *
 * 另一条：**冲突两边都画出来**。手册说 A、官网是 B 的时候，不画一个折中值、
 * 也不只画赢的那个，两个色块并排放，让用户点一下。我们没资格替他判他的手册
 * 和他的官网哪个是对的。
 *
 * 这个文件只画，不取数、不写回：取数在页面，写回走 `editBrandDesignToken`。
 */
import type { BrandDesignProfile, BrandDesignSource, BrandDesignValue } from '@agentsws/contracts'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useApp } from '@/lib/app-context'

/** 出处那一句人话。**手册记页码，官网记变量名 / 选择器**——两种来路读法不同。 */
function sourceLine(
  source: BrandDesignSource | undefined,
  t: ReturnType<typeof useApp>['t'],
): string {
  if (source === undefined) return ''
  if (source.page !== undefined) return t('design.md.source.page', { page: source.page })
  return [source.locator, source.url].filter((x) => x !== undefined).join(' · ')
}

/** 一个值外面那层「点开看出处」。 */
function WithSource({
  value,
  children,
}: {
  value: BrandDesignValue<unknown>
  children: React.ReactNode
}): React.ReactElement {
  const { t } = useApp()
  // Provider 就地包一层（与 `ui/hint.tsx` 同一个写法）：这些色块会出现在
  // 页面、右栏与档案卡三处，靠外层记得包一个 Provider 的话，迟早有一处忘了。
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help">{children}</div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="font-medium">{t('design.md.source')}</p>
          {value.source.slice(0, 3).map((s, i) => (
            <p key={`${s.locator ?? ''}-${String(i)}`} className="text-xs opacity-80">
              {sourceLine(s, t)}
            </p>
          ))}
          {value.source[0]?.quote === undefined ? null : (
            <p className="mt-1 text-xs italic opacity-70">「{value.source[0].quote}」</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** 一块色。名字、色值与用途都写在上面——一排没有名字的色块等于没有规范。 */
function Swatch({
  token,
  value,
}: {
  token: string
  value: BrandDesignValue<string>
}): React.ReactElement {
  const { t } = useApp()
  return (
    <div className="flex flex-col gap-1" data-testid={`design-md-color-${token}`}>
      <WithSource value={value}>
        <div
          className="h-14 w-full rounded-sm border border-ws-line"
          style={{ backgroundColor: value.value }}
        />
      </WithSource>
      <p className="font-medium text-xs">{token}</p>
      <p className="font-mono text-[11px] text-ws-muted-fg">{value.value}</p>
      {value.conflict === undefined ? null : (
        <div className="flex items-center gap-1" data-testid={`design-md-conflict-${token}`}>
          <div
            className="h-4 w-4 rounded-[2px] border border-ws-line"
            style={{ backgroundColor: value.conflict.value }}
            title={t('design.md.conflict.site')}
          />
          <span className="text-[10px] text-ws-muted-fg">{value.conflict.value}</span>
        </div>
      )}
    </div>
  )
}

/** 字样。用它自己的字体与字号画出来——一张字号表用同一号字排，看不出差别。 */
function TypeSample({
  token,
  value,
}: {
  token: string
  value: BrandDesignValue<{
    fontFamily?: string
    fontSize?: string
    fontWeight?: number
    lineHeight?: string | number
    letterSpacing?: string
  }>
}): React.ReactElement {
  const v = value.value
  return (
    <WithSource value={value}>
      <div className="flex flex-col gap-0.5 border-ws-line border-b py-2 last:border-0">
        <p
          className="truncate"
          style={{
            ...(v.fontFamily === undefined ? {} : { fontFamily: v.fontFamily }),
            ...(v.fontSize === undefined ? {} : { fontSize: v.fontSize }),
            ...(v.fontWeight === undefined ? {} : { fontWeight: v.fontWeight }),
            ...(v.lineHeight === undefined ? {} : { lineHeight: v.lineHeight }),
            ...(v.letterSpacing === undefined ? {} : { letterSpacing: v.letterSpacing }),
          }}
        >
          Agents 工坊 · The quick brown fox
        </p>
        <p className="text-[11px] text-ws-muted-fg">
          {token} ·{' '}
          {[v.fontFamily, v.fontSize, v.fontWeight].filter((x) => x !== undefined).join(' / ')}
        </p>
      </div>
    </WithSource>
  )
}

/** 一节的壳。**空的那一节不画成空格子**，画「未找到，请补充」。 */
function Section({
  titleKey,
  empty,
  children,
  testId,
}: {
  titleKey: string
  empty: boolean
  children: React.ReactNode
  testId: string
}): React.ReactElement {
  const { t } = useApp()
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <h3 className="font-medium text-ws-muted-fg text-xs uppercase tracking-wide">
        {t(titleKey)}
      </h3>
      {empty ? <p className="text-sm text-ws-muted-fg">{t('design.md.notfound')}</p> : children}
    </section>
  )
}

export interface TokensViewProps {
  profile: BrandDesignProfile
}

/**
 * 上半张：色板、字样、间距与圆角示意、按钮 / 卡片样例、logo 深浅底预览。
 *
 * 样例**用这些令牌实时渲染**，不是截图：用户改一个色值，样例当场跟着变。
 * 一张画好的示意图看起来更精致，但它不会因为用户改了值就变——那是在骗人。
 */
export function TokensView({ profile }: TokensViewProps): React.ReactElement {
  const { t } = useApp()
  const colors = Object.entries(profile.colors ?? {})
  const typography = Object.entries(profile.typography ?? {})
  const spacing = Object.entries(profile.spacing ?? {})
  const rounded = Object.entries(profile.rounded ?? {})
  const logos = profile.logos?.value ?? []

  const primary = profile.colors?.primary?.value ?? '#1a1c1e'
  const surface = profile.colors?.surface?.value ?? '#ffffff'
  const onSurface = profile.colors?.['on-surface']?.value ?? '#1a1c1e'
  const radius = profile.rounded?.md?.value ?? profile.rounded?.sm?.value ?? '8px'
  const pad = String(profile.spacing?.md?.value ?? '16px')

  return (
    <div className="flex flex-col gap-6" data-testid="design-md-tokens">
      <Section
        titleKey="design.md.section.colors"
        empty={colors.length === 0}
        testId="design-md-colors"
      >
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {colors.map(([token, value]) => (
            <Swatch key={token} token={token} value={value} />
          ))}
        </div>
      </Section>

      <Section
        titleKey="design.md.section.typography"
        empty={typography.length === 0}
        testId="design-md-typography"
      >
        <div className="flex flex-col">
          {typography.map(([token, value]) => (
            <TypeSample key={token} token={token} value={value} />
          ))}
        </div>
      </Section>

      <Section
        titleKey="design.md.section.spacing"
        empty={spacing.length === 0 && rounded.length === 0}
        testId="design-md-spacing"
      >
        <div className="flex flex-wrap items-end gap-4">
          {spacing.map(([token, value]) => (
            <WithSource key={token} value={value}>
              <div className="flex flex-col items-center gap-1">
                <div
                  className="bg-ws-brand"
                  style={{ width: String(value.value), height: String(value.value), minWidth: 2 }}
                />
                <span className="text-[11px] text-ws-muted-fg">
                  {token} {String(value.value)}
                </span>
              </div>
            </WithSource>
          ))}
          {rounded.map(([token, value]) => (
            <WithSource key={token} value={value}>
              <div className="flex flex-col items-center gap-1">
                <div
                  className="h-10 w-10 border-2 border-ws-brand"
                  style={{ borderRadius: value.value }}
                />
                <span className="text-[11px] text-ws-muted-fg">
                  {token} {value.value}
                </span>
              </div>
            </WithSource>
          ))}
        </div>
      </Section>

      {/* 样例：用上面那些令牌**实时渲染**，改一个值它当场跟着变 */}
      <Section
        titleKey="design.md.section.components"
        empty={colors.length === 0}
        testId="design-md-components"
      >
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex flex-col gap-1">
            <button
              type="button"
              className="px-4 py-2 font-medium text-sm"
              style={{ backgroundColor: primary, color: surface, borderRadius: radius }}
            >
              {t('design.md.button.sample')}
            </button>
          </div>
          <div
            className="flex min-w-40 flex-col gap-1 border border-ws-line"
            style={{
              backgroundColor: surface,
              color: onSurface,
              borderRadius: radius,
              padding: pad,
            }}
          >
            <span className="font-medium text-sm">{t('design.md.card.sample')}</span>
            <span className="text-xs opacity-70">{profile.name?.value ?? 'Agents 工坊'}</span>
          </div>
        </div>
      </Section>

      <Section titleKey="design.md.section.logo" empty={logos.length === 0} testId="design-md-logo">
        <div className="flex flex-wrap gap-4">
          {logos
            .filter((l) => l.url !== '')
            .map((logo) => (
              <div key={logo.url} className="flex flex-col items-center gap-1">
                <div
                  className="flex h-16 w-32 items-center justify-center rounded-sm border border-ws-line"
                  style={{ backgroundColor: logo.variant === 'dark' ? onSurface : surface }}
                >
                  <img src={logo.url} alt="" className="max-h-12 max-w-28 object-contain" />
                </div>
                <span className="text-[11px] text-ws-muted-fg">
                  {t(
                    logo.variant === 'dark' ? 'design.md.preview.dark' : 'design.md.preview.light',
                  )}
                </span>
              </div>
            ))}
        </div>
      </Section>
    </div>
  )
}

/** 档案卡与右栏那一行摘要：**N 色 · N 字体 · N 个 logo**。 */
export function designSummary(profile: BrandDesignProfile): {
  colors: number
  fonts: number
  logos: number
} {
  const fonts = new Set(
    Object.values(profile.typography ?? {})
      .map((v) => v.value.fontFamily)
      .filter((x): x is string => x !== undefined),
  )
  return {
    colors: Object.keys(profile.colors ?? {}).length,
    fonts: fonts.size,
    logos: (profile.logos?.value ?? []).filter((l) => l.url !== '').length,
  }
}

/** 这份档案里还有几处两边说法不一样（界面上那个角标）。 */
export function countConflicts(profile: BrandDesignProfile): number {
  let n = 0
  const walk = (rec: Record<string, BrandDesignValue<unknown>> | undefined): void => {
    for (const v of Object.values(rec ?? {})) if (v.conflict !== undefined) n++
  }
  walk(profile.colors)
  walk(profile.typography as Record<string, BrandDesignValue<unknown>> | undefined)
  walk(profile.rounded)
  walk(profile.spacing as Record<string, BrandDesignValue<unknown>> | undefined)
  walk(profile.shadows)
  return n
}
