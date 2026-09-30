/**
 * WP156（36 §7 第三档）：右栏「教程」面板。
 *
 * 两种打开法：
 *
 * - 卡片上点「看教程」→ 为 `agentsws://help/<slug>` 打开（注册表 `resolvePanel()` 排到这里），
 *   直接显示那一篇，顶上一个「‹」回目录；
 * - 人点图标轨打开（没有地址）→ 显示目录，点一篇在同一个面板里换过去。
 *
 * **WP208（Luoye 09-30）：目录跟着上下文走**。「点到某个岗位下的第三栏，就显示这个岗位相关的教程；
 * 点了职责，就是这个职责下相关的教程。」——
 *
 * - 在职责上：这条职责的 → 所属岗位的 → 通用；
 * - 在岗位上：这个岗位的 → 通用；
 * - 哪儿都不在：通用。
 *
 * 哪篇归谁写在文章自己的 frontmatter 里（`lib/help.ts` 的 `HELP_SCOPES` 是镜像）。
 * 别的岗位的那几篇不删：顶上的搜索搜全部，最底下「全部 N 篇」一下全摊开。
 * 面板仍不 `scoped`（没有层切换）：范围跟着右栏算出来的那一层走，人不用在这里再选一次。
 */
import { ChevronLeft, Search } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { HelpBody } from '@/components/help/help-body'
import type { RailScope } from '@/components/rail/rail-scope'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { Input } from '@/components/ui/input'
import { useApp } from '@/lib/app-context'
import { HELP_SLUGS, type HelpSlug, helpForContext, helpSlugOf } from '@/lib/help'
import { translate } from '@/lib/i18n'

/** 右栏那一层 → 教程目录的上下文（职责层顺带它所属的岗位）。 */
function contextOf(scope: RailScope | undefined): { role_id?: string; position_id?: string } {
  if (scope === undefined) return {}
  if (scope.tier === 'role')
    return {
      role_id: scope.scope_id,
      ...(scope.parent === undefined ? {} : { position_id: scope.parent.scope_id }),
    }
  return { position_id: scope.scope_id }
}

/** 搜索：中英两个标题都算（与 ⌘K 那一组同一条口径）。 */
function searchHelp(query: string): HelpSlug[] {
  const q = query.trim().toLowerCase()
  return HELP_SLUGS.filter((slug) =>
    `${translate('zh', `help.${slug}.title`)} ${translate('en', `help.${slug}.title`)} ${slug}`
      .toLowerCase()
      .includes(q),
  )
}

export function HelpPanel({ address, scope }: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  /**
   * 人在面板里点过的（目录里挑了一篇 / 点了「全部教程」）。记着是**在哪个地址下**点的：
   * 又点了另一张卡的「看教程」（地址换了）就以地址为准。
   */
  const [picked, setPicked] = useState<{ for: string | undefined; view: HelpSlug | 'index' }>()
  const view: HelpSlug | 'index' =
    picked !== undefined && picked.for === address ? picked.view : (helpSlugOf(address) ?? 'index')
  const go = (next: HelpSlug | 'index'): void => {
    setPicked({ for: address, view: next })
  }

  if (view === 'index') return <HelpIndex scope={scope} onPick={go} />

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="help-panel" data-slug={view}>
      <button
        type="button"
        data-testid="help-back"
        className="inline-flex items-center gap-0.5 self-start text-xs text-ws-muted-fg hover:text-foreground"
        onClick={() => {
          go('index')
        }}
      >
        <ChevronLeft aria-hidden className="size-3.5" />
        {/* WP208：目录不再是"全部"，而是跟着上下文的那一份——回去那一格就叫「教程」 */}
        {t('rail.panel.help')}
      </button>
      <HelpBody slug={view} />
    </div>
  )
}

/** 目录：上下文分组 + 搜索（搜全部）+ 「全部 N 篇」。 */
function HelpIndex({
  scope,
  onPick,
}: {
  scope: RailScope | undefined
  onPick: (slug: HelpSlug) => void
}): ReactNode {
  const { t } = useApp()
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const groups = helpForContext(contextOf(scope))
  const sections: { key: string; title: string; slugs: HelpSlug[] }[] = all
    ? [{ key: 'all', title: t('help.index'), slugs: [...HELP_SLUGS] }]
    : [
        { key: 'role', title: t('help.ctx.role'), slugs: groups.role },
        { key: 'position', title: t('help.ctx.position'), slugs: groups.position },
        { key: 'general', title: t('help.ctx.general'), slugs: groups.general },
      ].filter((g) => g.slugs.length > 0)
  const hits = query.trim() === '' ? undefined : searchHelp(query)
  // 只有一组时不写组名（"通用"两个字挂在唯一一组上面只是噪音）
  const titled = sections.length > 1 || all
  const shown = sections.reduce((n, g) => n + g.slugs.length, 0)

  const item = (slug: HelpSlug): ReactNode => (
    <button
      key={slug}
      type="button"
      data-testid="help-index-item"
      data-slug={slug}
      className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
      onClick={() => {
        onPick(slug)
      }}
    >
      {t(`help.${slug}.title`)}
    </button>
  )

  return (
    <nav className="flex flex-col gap-2 p-3" data-testid="help-panel" data-slug="">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-ws-muted-fg"
        />
        <Input
          className="h-8 pl-7 text-sm"
          aria-label={t('help.search')}
          placeholder={t('help.search')}
          data-testid="help-search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
          }}
        />
      </div>
      {hits !== undefined ? (
        hits.length === 0 ? (
          <p className="px-2 text-xs text-ws-muted-fg" data-testid="help-search-empty">
            {t('help.search.empty')}
          </p>
        ) : (
          <div className="flex flex-col" data-testid="help-search-hits">
            {hits.map(item)}
          </div>
        )
      ) : (
        <>
          {sections.map((g) => (
            <section
              key={g.key}
              className="flex flex-col"
              data-testid="help-index-group"
              data-group={g.key}
            >
              {titled ? <p className="px-2 pb-0.5 text-xs text-ws-muted-fg">{g.title}</p> : null}
              {g.slugs.map(item)}
            </section>
          ))}
          {all || shown === HELP_SLUGS.length ? null : (
            <button
              type="button"
              data-testid="help-show-all"
              className="self-start px-2 text-xs text-ws-muted-fg hover:text-foreground"
              onClick={() => {
                setAll(true)
              }}
            >
              {t('help.show_all', { count: HELP_SLUGS.length })}
            </button>
          )}
        </>
      )}
    </nav>
  )
}
